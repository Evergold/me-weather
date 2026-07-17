// main.rs (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as TokioMutex};
pub mod cluster;

// Shared Game State Authority
#[allow(dead_code)]
struct AppState {
    tx: broadcast::Sender<String>,
    offer_tx: tokio::sync::mpsc::Sender<(String, String, tokio::sync::oneshot::Sender<String>)>,
    data_tx: tokio::sync::mpsc::Sender<(String, Vec<u8>)>,
    physics: physics::PhysicsSolver,
    collider: physics::collider::WorldCollider,
    // ScyllaDB Session for Dynamic Server Meshing & Persistence
    db: Option<Arc<scylla::client::session::Session>>,
    cluster: Option<Arc<TokioMutex<cluster::ClusterManager>>>,
    pause_on_idle: bool,
    enable_hydrology: bool,
    gpu_vram_gb: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct ControlMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    season: Option<String>,
    time_of_day: Option<f32>,
    wind_x: Option<f32>,
    wind_y: Option<f32>,
    sdp: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    
    dotenvy::dotenv().ok(); // Load environment variables from .env file
    
    tracing::info!("[Orchestrator] Booting monolithic Rust backend on port 8000...");

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
    
    tracing::info!("[Database] Attempting to connect to ScyllaDB at {}...", scylla_uri);
    let mut db_session_opt = None;
    
    match scylla::client::session_builder::SessionBuilder::new().known_node(&scylla_uri).build().await {
        Ok(session) => {
            tracing::info!("[Database] Successfully connected to ScyllaDB cluster.");
            db_session_opt = Some(session);
        },
        Err(e) => {
            tracing::info!("[Database] Connection failed ({}). Attempting to automatically start ScyllaDB via Docker...", e);
            // First try to start an existing container
            let start_result = std::process::Command::new("docker")
                .args(["start", "scylla-node"])
                .output();
                
            let docker_result = if start_result.is_ok() && start_result.as_ref().unwrap().status.success() {
                start_result
            } else {
                // If it doesn't exist or failed to start, run a new one
                let _ = std::process::Command::new("docker").args(["rm", "-f", "scylla-node"]).output();
                std::process::Command::new("docker")
                    .args([
                        "run", "--name", "scylla-node", "-d",
                        "--network", "host",
                        "scylladb/scylla:5.4.0",
                        "--developer-mode", "1",
                        "--listen-address", "127.0.0.1",
                        "--rpc-address", "127.0.0.1",
                        "--broadcast-address", "127.0.0.1",
                        "--broadcast-rpc-address", "127.0.0.1"
                    ])
                    .output()
            };
                
            if docker_result.is_ok() && docker_result.as_ref().unwrap().status.success() {
                tracing::info!("[Database] Docker container started. Waiting 40 seconds for ScyllaDB to initialize...");
                tokio::time::sleep(std::time::Duration::from_secs(40)).await;
                
                // Retry connection
                if let Ok(session) = scylla::client::session_builder::SessionBuilder::new().known_node(&scylla_uri).build().await {
                    tracing::info!("[Database] Successfully auto-started and connected to local ScyllaDB cluster!");
                    db_session_opt = Some(session);
                } else {
                    tracing::info!("[Database] Auto-start timed out. Running in isolated single-node mode.");
                }
            } else {
                tracing::info!("[Database] Docker is not available. Running in isolated single-node mode.");
            }
        }
    }
    
    let db_session = if let Some(session) = db_session_opt {
        // Scaffold the Keyspace and Table for Server Meshing
        let _ = session.query_unpaged("CREATE KEYSPACE IF NOT EXISTS weather_sim WITH REPLICATION = {'class' : 'SimpleStrategy', 'replication_factor' : 1}", &[]).await;
        let _ = session.query_unpaged("CREATE TABLE IF NOT EXISTS weather_sim.tiles (tile_id text PRIMARY KEY, data blob, last_updated timestamp)", &[]).await;
        
        let mut num_snapshots: usize = std::env::var("NUM_SNAPSHOTS")
            .unwrap_or_else(|_| "2".to_string())
            .parse()
            .unwrap_or(2);
            
        if num_snapshots < 1 {
            num_snapshots = 1;
        }
            
        let scylla_api = std::env::var("SCYLLA_API").unwrap_or_else(|_| "http://127.0.0.1:10000".to_string());
        let api_client = reqwest::Client::new();
        tokio::spawn(async move {
            let mut snapshot_tags = std::collections::VecDeque::new();
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(300));
            
            interval.tick().await; // Consume immediate tick
            
            loop {
                interval.tick().await;
                let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
                let tag = format!("auto_{}", timestamp);
                let url = format!("{}/storage_service/snapshots?tag={}", scylla_api, tag);
                
                match api_client.post(&url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        tracing::info!("[Database] Created automatic ScyllaDB snapshot: {}", tag);
                        snapshot_tags.push_back(tag);
                        
                        while snapshot_tags.len() > num_snapshots {
                            if let Some(old_tag) = snapshot_tags.pop_front() {
                                let del_url = format!("{}/storage_service/snapshots?tag={}", scylla_api, old_tag);
                                match api_client.delete(&del_url).send().await {
                                    Ok(del_resp) if del_resp.status().is_success() => {
                                        tracing::info!("[Database] Pruned old snapshot: {}", old_tag);
                                    },
                                    Ok(del_resp) => {
                                        tracing::warn!("[Database] Failed to prune {}: HTTP {}", old_tag, del_resp.status());
                                    },
                                    Err(e) => {
                                        tracing::error!("[Database] Error pruning {}: {}", old_tag, e);
                                    }
                                }
                            }
                        }
                    },
                    Ok(resp) => {
                        tracing::warn!("[Database] Failed to create snapshot: HTTP {}", resp.status());
                    },
                    Err(e) => {
                        tracing::error!("[Database] Error creating snapshot: {}", e);
                    }
                }
            }
        });
        
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
    let (offer_tx, offer_rx) = tokio::sync::mpsc::channel::<(String, String, tokio::sync::oneshot::Sender<String>)>(100);
    let (data_tx, data_rx) = tokio::sync::mpsc::channel::<(String, Vec<u8>)>(100);

    let app_state = Arc::new(AppState { 
        tx,
        offer_tx,
        data_tx,
        physics: physics_engine,
        collider,
        db: db_session,
        cluster: cluster_opt,
        pause_on_idle,
        enable_hydrology,
        gpu_vram_gb,
    });

    let (webrtc_tx, mut webrtc_rx) = tokio::sync::mpsc::channel::<(String, Vec<u8>)>(100);

    // 2. Spawn the UDP WebRTC DataChannel Router natively in a background task
    tokio::spawn(async move {
        if let Err(e) = webrtc_router::start_webrtc_server(webrtc_tx, offer_rx, data_rx).await {
            tracing::error!("[WebRTC] Router crashed: {}", e);
        }
    });

    // Handle incoming WebRTC cluster commands
    let router_cluster = app_state.cluster.clone();
    let data_tx_clone = app_state.data_tx.clone();
    tokio::spawn(async move {
        while let Some((node_id, data)) = webrtc_rx.recv().await {
            // First check if it's a string command (CLAIM/COMPLETE)
            if let Ok(msg) = String::from_utf8(data.clone()) {
                if let Some(cluster) = &router_cluster {
                    let mut cm = cluster.lock().await;
                    if msg == "CLAIM" {
                        if let Some(tile) = cm.claim_tile(node_id.clone(), None) {
                            tracing::info!("[Gateway] Node {} claimed tile {}", node_id, tile);
                            
                            // Create a dummy float array (e.g. 4096 floats) representing the tile state to send
                            let mut fake_tile_data: Vec<u8> = Vec::with_capacity(4096 * 4);
                            for i in 0..4096 {
                                fake_tile_data.extend_from_slice(&(i as f32).to_le_bytes());
                            }
                            
                            // Actually stream the tile float grid down the datachannel!
                            tracing::info!("[Gateway] Streaming {} bytes of tile data to Node {}...", fake_tile_data.len(), node_id);
                            let _ = data_tx_clone.send((node_id.clone(), fake_tile_data)).await;
                            
                        } else {
                            tracing::info!("[Gateway] Node {} requested tile but none available or throttled", node_id);
                        }
                    } else if msg.starts_with("COMPLETE:") {
                        let tile_id = msg.trim_start_matches("COMPLETE:");
                        cm.complete_tile(tile_id, &node_id);
                        tracing::info!("[Gateway] Node {} completed tile {}", node_id, tile_id);
                    }
                }
            } else {
                // If it's pure binary data, this is a computed tile coming back from a node!
                tracing::info!("[Gateway] Received {} bytes of computed binary data from Node {}", data.len(), node_id);
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
                if let Some(tile_id) = cm.claim_tile("local_host".to_string(), None) {
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
        .merge(tile_router)
        .layer(tower_http::cors::CorsLayer::permissive());

    // Bind monolithic HTTP server to port 8000
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    tracing::info!("[Orchestrator] Axum gateway & tile server running on ws://127.0.0.1:8000");
    
    axum::serve(listener, app).await.unwrap();

    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::Path(id): axum::extract::Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, id))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, client_id: String) {
    let mut rx = state.tx.subscribe();

    loop {
        tokio::select! {
            // Receive control messages from this player
            msg = socket.recv() => {
                if let Some(Ok(Message::Text(text))) = msg {
                    if let Ok(parsed) = serde_json::from_str::<ControlMessage>(text.as_str()) {
                        tracing::info!("[Gateway] Parsed: {:?}", parsed);
                        
                        if parsed.msg_type.as_deref() == Some("webrtc_offer") {
                            if let Some(offer) = parsed.sdp {
                                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                                if state.offer_tx.send((client_id.clone(), offer, reply_tx)).await.is_ok() {
                                    if let Ok(answer) = reply_rx.await {
                                        let answer_msg = serde_json::json!({
                                            "type": "webrtc_answer",
                                            "sdp": answer
                                        });
                                        let _ = socket.send(Message::Text(serde_json::to_string(&answer_msg).unwrap().into())).await;
                                    }
                                }
                            }
                        } else {
                            // Only broadcast non-WebRTC control messages to other players
                            let _ = state.tx.send(text.to_string());
                        }
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
