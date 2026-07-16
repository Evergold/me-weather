use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as TokioMutex};
use std::net::SocketAddr;
pub mod cluster;

// Shared Game State Authority
struct AppState {
    tx: broadcast::Sender<String>,
    physics: physics::PhysicsSolver,
    collider: physics::collider::WorldCollider,
    // ScyllaDB Session for Dynamic Server Meshing & Persistence
    db: Option<Arc<scylla::client::session::Session>>,
    cluster: Option<Arc<TokioMutex<cluster::ClusterManager>>>,
    pause_on_idle: bool,
    enable_hydrology: bool,
    gpu_vram_gb: u32,
}

#[derive(Serialize, Deserialize, Debug)]
struct ControlMessage {
    season: Option<String>,
    time_of_day: Option<f32>,
    wind_x: Option<f32>,
    wind_y: Option<f32>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok(); // Load environment variables from .env file
    
    println!("[Orchestrator] Booting monolithic Rust backend on port 8000...");

    // Parse configuration from .env
    let pause_on_idle = std::env::var("PAUSE_ON_IDLE").unwrap_or_else(|_| "True".to_string()).eq_ignore_ascii_case("true");
    let enable_hydrology = std::env::var("ENABLE_HYDROLOGY").unwrap_or_else(|_| "True".to_string()).eq_ignore_ascii_case("true");
    let gpu_vram_gb = std::env::var("GPU_VRAM_GB").unwrap_or_else(|_| "8".to_string()).parse::<u32>().unwrap_or(8);
    let headless = std::env::var("HEADLESS").unwrap_or_else(|_| "False".to_string()).eq_ignore_ascii_case("true");
    let force_meshing = std::env::var("FORCE_MESHING").unwrap_or_else(|_| "False".to_string());

    let heightmap_filename = std::env::var("HEIGHTMAP_FILENAME").unwrap_or_else(|_| "heightmap_coarse.png".to_string());
    let heightmap_path = format!("../server/assets/{}", heightmap_filename);
    
    // 1. Initialize the WGPU Physics Engine (in-memory)
    let physics_engine = physics::PhysicsSolver::new(16384, 16384, gpu_vram_gb, headless, force_meshing.clone(), "@group(0) @binding(0) var<storage, read_write> data: array<f32>; @compute @workgroup_size(1) fn main() { data[0] = 0.0; }").await;
    
    // 2. Initialize the Server-Authoritative Anti-Cheat Collider
    let collider = physics::collider::WorldCollider::new(&heightmap_path, 2000.0, 2000.0, 250.0);
    
    let scylla_uri = std::env::var("SCYLLA_URI").unwrap_or_else(|_| "127.0.0.1:9042".to_string());
    
    println!("[Database] Attempting to connect to ScyllaDB at {}...", scylla_uri);
    let mut db_session_opt = None;
    
    match scylla::client::session_builder::SessionBuilder::new().known_node(&scylla_uri).build().await {
        Ok(session) => {
            println!("[Database] Successfully connected to ScyllaDB cluster.");
            db_session_opt = Some(session);
        },
        Err(e) => {
            println!("[Database] Connection failed ({}). Attempting to automatically start ScyllaDB via Docker...", e);
            let docker_result = std::process::Command::new("docker")
                .args(["run", "--name", "scylla-node", "-d", "-p", "9042:9042", "scylladb/scylla:5.4.0"])
                .output();
                
            if docker_result.is_ok() {
                println!("[Database] Docker container started. Waiting 15 seconds for ScyllaDB to initialize...");
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                
                // Retry connection
                if let Ok(session) = scylla::client::session_builder::SessionBuilder::new().known_node(&scylla_uri).build().await {
                    println!("[Database] Successfully auto-started and connected to local ScyllaDB cluster!");
                    db_session_opt = Some(session);
                } else {
                    println!("[Database] Auto-start timed out. Running in isolated single-node mode.");
                }
            } else {
                println!("[Database] Docker is not available. Running in isolated single-node mode.");
            }
        }
    }
    
    let db_session = if let Some(session) = db_session_opt {
        // Scaffold the Keyspace and Table for Server Meshing
        let _ = session.query_unpaged("CREATE KEYSPACE IF NOT EXISTS weather_sim WITH REPLICATION = {'class' : 'SimpleStrategy', 'replication_factor' : 1}", &[]).await;
        let _ = session.query_unpaged("CREATE TABLE IF NOT EXISTS weather_sim.tiles (tile_id text PRIMARY KEY, data blob, last_updated timestamp)", &[]).await;
        Some(Arc::new(session))
    } else {
        None
    };

    let mut cluster_opt = None;
    if let physics::ExecutionMode::Tiled { .. } = physics_engine.mode {
        let mut tiles = Vec::new();
        // 16384x16384 map, 4096x4096 tiles -> 4x4 grid
        for x in 0..4 {
            for y in 0..4 {
                tiles.push(format!("tile_4096_{}_{}", x, y));
            }
        }
        cluster_opt = Some(Arc::new(TokioMutex::new(cluster::ClusterManager::new(tiles))));
    }

    let (tx, _rx) = broadcast::channel(100);
    let app_state = Arc::new(AppState { 
        tx,
        physics: physics_engine,
        collider,
        db: db_session,
        cluster: cluster_opt,
        pause_on_idle,
        enable_hydrology,
        gpu_vram_gb,
    });

    let (webrtc_tx, mut webrtc_rx) = tokio::sync::mpsc::channel::<(String, String)>(100);

    // 2. Spawn the UDP WebRTC DataChannel Router natively in a background task
    tokio::spawn(async move {
        if let Err(e) = webrtc_router::start_webrtc_server(webrtc_tx).await {
            eprintln!("[WebRTC] Router crashed: {}", e);
        }
    });

    // Handle incoming WebRTC cluster commands
    let router_cluster = app_state.cluster.clone();
    tokio::spawn(async move {
        while let Some((node_id, msg)) = webrtc_rx.recv().await {
            if let Some(cluster) = &router_cluster {
                let mut cm = cluster.lock().await;
                if msg == "CLAIM" {
                    if let Some(tile) = cm.claim_tile(node_id.clone()) {
                        println!("[Gateway] Node {} claimed tile {}", node_id, tile);
                        // Future: Actually stream the tile float grid down the datachannel
                    } else {
                        println!("[Gateway] Node {} requested tile but none available or throttled", node_id);
                    }
                } else if msg.starts_with("COMPLETE:") {
                    let tile_id = msg.trim_start_matches("COMPLETE:");
                    cm.complete_tile(tile_id, &node_id);
                    println!("[Gateway] Node {} completed tile {}", node_id, tile_id);
                }
            }
        }
    });

    // 3. Background Physics Tick Loop (60 FPS)
    let ticker_state = app_state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(16));
        loop {
            interval.tick().await;
            
            // If PAUSE_ON_IDLE is true, we only tick if there's at least 1 active websocket player
            if ticker_state.pause_on_idle && ticker_state.tx.receiver_count() == 0 {
                continue;
            }

            if let Some(cluster) = &ticker_state.cluster {
                let mut cm = cluster.lock().await;
                cm.check_timeouts();
                
                // Process up to 1 tile locally per tick to maintain 60 FPS
                if let Some(tile_id) = cm.claim_tile("local_host".to_string()) {
                    // For now, simulate work completion (eventually will call ticker_state.physics.update_tile)
                    cm.complete_tile(&tile_id, "local_host");
                }
            } else {
                // Note: In the future, we will use ticker_state.enable_hydrology 
                // to conditionally skip the moisture shader passes here!
                ticker_state.physics.update(16, 16);
            }
        }
    });

    // 4. Merge the Game State Websocket with the Tile Streamer (Axum)
    let gateway_router = Router::new()
        .route("/ws/control/{id}", get(ws_handler))
        .with_state(app_state);

    let tile_router = tile_server::build_router();

    let app = Router::new()
        .merge(gateway_router)
        .merge(tile_router);

    // Bind monolithic HTTP server to port 8000
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    println!("[Orchestrator] Axum gateway & tile server running on ws://127.0.0.1:8000");
    
    axum::serve(listener, app).await.unwrap();

    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.tx.subscribe();

    loop {
        tokio::select! {
            // Receive control messages from this player
            msg = socket.recv() => {
                if let Some(Ok(Message::Text(text))) = msg {
                    if let Ok(parsed) = serde_json::from_str::<ControlMessage>(text.as_str()) {
                        println!("[Gateway] Parsed: {:?}", parsed);
                        
                        let _ = state.tx.send(text.to_string());
                    }
                } else if msg.is_none() {
                    break;
                }
            }
            // Receive global state broadcasts from other players
            Ok(msg) = rx.recv() => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break; // Socket closed
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_control_message_parsing() {
        let raw_json = r#"{"season": "Winter", "time_of_day": 14.5, "wind_x": 0.5, "wind_y": -0.2}"#;
        let parsed: ControlMessage = serde_json::from_str(raw_json).unwrap();
        
        assert_eq!(parsed.season.as_deref(), Some("Winter"));
        assert_eq!(parsed.time_of_day, Some(14.5));
        assert_eq!(parsed.wind_x, Some(0.5));
        assert_eq!(parsed.wind_y, Some(-0.2));
    }
}
