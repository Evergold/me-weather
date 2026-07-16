use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

// Shared Game State Authority
struct AppState {
    // Channel for broadcasting state changes (season, time) to all active player WebSockets
    tx: broadcast::Sender<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ControlMessage {
    season: Option<String>,
    time_of_day: Option<f32>,
    wind_x: Option<f32>,
    wind_y: Option<f32>,
}

#[tokio::main]
async fn main() {
    println!("[Gateway] Booting Rust Game State Authority on port 8000...");

    let (tx, _rx) = broadcast::channel(100);
    let app_state = Arc::new(AppState { tx });

    let app = Router::new()
        .route("/ws/control", get(ws_handler))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    println!("[Gateway] Listening for WebSocket connections on ws://0.0.0.0:8000/ws/control");

    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.tx.subscribe();

    println!("[Gateway] New player connected to Control Socket.");

    loop {
        tokio::select! {
            // Receive commands from the player
            msg = socket.recv() => {
                if let Some(Ok(Message::Text(text))) = msg {
                    println!("[Gateway] Received control command: {}", text);
                    if let Ok(parsed) = serde_json::from_str::<ControlMessage>(text.as_str()) {
                        println!("[Gateway] Parsed: {:?}", parsed);
                        
                        // In a full implementation, we would forward this via gRPC to the Physics Engine.
                        // For now, broadcast it to all other players to sync the world state.
                        let _ = state.tx.send(text.to_string());
                    }
                } else if msg.is_none() {
                    println!("[Gateway] Player disconnected.");
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
