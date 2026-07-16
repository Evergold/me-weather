use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use std::net::SocketAddr;

// Shared Game State Authority
struct AppState {
    // Channel for broadcasting state changes (season, time) to all active player WebSockets
    tx: broadcast::Sender<String>,
    // Physics engine state for monolithic in-memory dispatches
    physics: physics::PhysicsSolver,
    // Configuration from .env
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

    // 1. Initialize the WGPU Physics Engine (in-memory)
    let physics_engine = physics::PhysicsSolver::new(16384, 16384, gpu_vram_gb, "@group(0) @binding(0) var<storage, read_write> data: array<f32>; @compute @workgroup_size(1) fn main() { data[0] = 0.0; }").await;
    let (tx, _rx) = broadcast::channel(100);
    let app_state = Arc::new(AppState { 
        tx,
        physics: physics_engine,
        pause_on_idle,
        enable_hydrology,
        gpu_vram_gb,
    });

    // 2. Spawn the UDP WebRTC DataChannel Router natively in a background task
    tokio::spawn(async move {
        if let Err(e) = webrtc_router::start_webrtc_server().await {
            eprintln!("[WebRTC] Router crashed: {}", e);
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

            // Note: In the future, we will use ticker_state.enable_hydrology 
            // to conditionally skip the moisture shader passes here!
            ticker_state.physics.update(16, 16);
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
