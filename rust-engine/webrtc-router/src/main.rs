use std::sync::Arc;
use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::interceptor::registry::Registry;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("[WebRTC Router] Booting massively parallel Rust WebRTC router...");

    // Create a MediaEngine object to configure the supported codecs
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    // Create a InterceptorRegistry
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;

    // Create the API object with the MediaEngine
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();

    // Prepare the configuration (e.g. STUN/TURN servers)
    let config = RTCConfiguration {
        ice_servers: vec![webrtc::ice_transport::ice_server::RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };

    // Create a new RTCPeerConnection (Simulating a single incoming player connection)
    let peer_connection = Arc::new(api.new_peer_connection(config).await?);
    
    // Set the handler for Peer connection state
    peer_connection.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        println!("[WebRTC Router] Peer Connection State has changed: {}", s);
        if s == RTCPeerConnectionState::Failed {
            println!("[WebRTC Router] Peer Connection has gone to failed exiting");
        }
        Box::pin(async {})
    }));

    // Register DataChannel creation handler
    peer_connection.on_data_channel(Box::new(move |d: Arc<RTCDataChannel>| {
        let d_label = d.label().to_owned();
        let d_id = d.id();
        println!("[WebRTC Router] New DataChannel '{}' ({})", d_label, d_id);

        d.on_open(Box::new(move || {
            println!("[WebRTC Router] Data channel '{}' ({}) open. Ready for massive telemetry.", d_label, d_id);
            Box::pin(async {})
        }));

        let d2 = Arc::clone(&d);
        d.on_message(Box::new(move |msg: DataChannelMessage| {
            let msg_str = String::from_utf8(msg.data.to_vec()).unwrap_or_else(|_| "Binary data".to_string());
            println!("[WebRTC Router] Message from DataChannel '{}': '{}'", d2.label(), msg_str);
            Box::pin(async {})
        }));

        Box::pin(async {})
    }));

    println!("[WebRTC Router] Ready to accept SDP offers via Gateway signaling...");
    
    // In a real server, we would now listen for SDP offers coming from the Axum Gateway via gRPC,
    // apply them with `set_remote_description`, generate an answer, and stream the float grids.

    Ok(())
}
