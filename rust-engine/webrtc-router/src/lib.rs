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
use tokio::sync::mpsc;

pub async fn start_webrtc_server(
    tx: mpsc::Sender<(String, String)>,
    mut offer_rx: mpsc::Receiver<(String, tokio::sync::oneshot::Sender<String>)>
) -> Result<(), Box<dyn std::error::Error>> {
    println!("[WebRTC Router] Booting massively parallel Rust WebRTC router...");

    // Create a MediaEngine object to configure the supported codecs
    let mut m = MediaEngine::default();
    m.register_default_codecs()?;

    // Create a InterceptorRegistry
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)?;

    // Create the API object with the MediaEngine
    let api = Arc::new(APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build());

    // Prepare the configuration (e.g. STUN/TURN servers)
    let config = RTCConfiguration {
        ice_servers: vec![webrtc::ice_transport::ice_server::RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };

    println!("[WebRTC Router] Ready to accept SDP offers via Gateway signaling...");
    
    while let Some((offer_str, reply_tx)) = offer_rx.recv().await {
        println!("[WebRTC Router] Received SDP offer, generating peer connection...");
        let api_clone = Arc::clone(&api);
        let config_clone = config.clone();
        let tx_clone = tx.clone();
        
        tokio::spawn(async move {
            let peer_connection = Arc::new(api_clone.new_peer_connection(config_clone).await.unwrap());
            
            // Set the handler for Peer connection state
            peer_connection.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                println!("[WebRTC Router] Peer Connection State has changed: {}", s);
                if s == RTCPeerConnectionState::Failed {
                    println!("[WebRTC Router] Peer Connection has gone to failed exiting");
                }
                Box::pin(async {})
            }));

            // Register DataChannel creation handler
            let tx_clone2 = tx_clone.clone();
            peer_connection.on_data_channel(Box::new(move |d: Arc<RTCDataChannel>| {
                let d_label = d.label().to_owned();
                let d_id = d.id();
                println!("[WebRTC Router] New DataChannel '{}' ({})", d_label, d_id);

                d.on_open(Box::new(move || {
                    println!("[WebRTC Router] Data channel '{}' open.", d_label);
                    Box::pin(async {})
                }));

                let tx_clone3 = tx_clone2.clone();
                let d2 = Arc::clone(&d);
                d.on_message(Box::new(move |msg: DataChannelMessage| {
                    let msg_str = String::from_utf8(msg.data.to_vec()).unwrap_or_else(|_| "Binary data".to_string());
                    let d_label2 = d2.label().to_string();
                    let tx3 = tx_clone3.clone();
                    Box::pin(async move {
                        let _ = tx3.send((d_label2, msg_str)).await;
                    })
                }));

                Box::pin(async {})
            }));
            
            // Apply offer
            let desc = webrtc::peer_connection::sdp::session_description::RTCSessionDescription::offer(offer_str).unwrap();
            peer_connection.set_remote_description(desc).await.unwrap();
            
            // Create answer
            let answer = peer_connection.create_answer(None).await.unwrap();
            
            // Set local description
            peer_connection.set_local_description(answer.clone()).await.unwrap();
            
            // Send answer back to axum gateway
            let _ = reply_tx.send(answer.sdp);
        });
    }

    Ok(())
}
