use std::sync::Arc;
use tokio::sync::Mutex;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::interceptor::registry::Registry;
use tokio::sync::mpsc;

use std::collections::HashMap;

pub async fn start_webrtc_server(
    tx: mpsc::Sender<(String, Vec<u8>)>,
    mut offer_rx: mpsc::Receiver<(String, String, tokio::sync::oneshot::Sender<String>)>,
    mut data_rx: mpsc::Receiver<(String, Vec<u8>)>
) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("[WebRTC Router] Booting massively parallel Rust WebRTC router...");

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

    tracing::info!("[WebRTC Router] Ready to accept SDP offers via Gateway signaling...");
    
    let active_channels: Arc<Mutex<HashMap<String, Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(HashMap::new()));
    
    let channels_clone = active_channels.clone();
    tokio::spawn(async move {
        while let Some((client_id, data)) = data_rx.recv().await {
            let map = channels_clone.lock().await;
            if let Some(dc) = map.get(&client_id) {
                let _ = dc.send(&bytes::Bytes::from(data)).await;
            }
        }
    });

    while let Some((client_id, offer_str, reply_tx)) = offer_rx.recv().await {
        tracing::info!("[WebRTC Router] Received SDP offer for {}, generating peer connection...", client_id);
        let api_clone = Arc::clone(&api);
        let config_clone = config.clone();
        let tx_clone = tx.clone();
        let channels_clone = active_channels.clone();
        
        let client_id_for_dc = client_id.clone();
        
        tokio::spawn(async move {
            let peer_connection = Arc::new(api_clone.new_peer_connection(config_clone).await.unwrap());
            
            // Set the handler for Peer connection state
            peer_connection.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                tracing::info!("[WebRTC Router] Peer Connection State has changed: {}", s);
                if s == RTCPeerConnectionState::Failed {
                    tracing::info!("[WebRTC Router] Peer Connection has gone to failed exiting");
                }
                Box::pin(async {})
            }));

            // Register DataChannel creation handler
            let tx_clone2 = tx_clone.clone();
            let channels_clone_for_dc = channels_clone.clone();
            peer_connection.on_data_channel(Box::new(move |d: Arc<RTCDataChannel>| {
                let d_label = d.label().to_owned();
                let d_id = d.id();
                tracing::info!("[WebRTC Router] New DataChannel '{}' ({})", d_label, d_id);

                let client_id_clone = client_id_for_dc.clone();
                let client_id_clone2 = client_id_for_dc.clone();
                
                let channels_map = channels_clone_for_dc.clone();
                let d_clone_for_map = Arc::clone(&d);
                let client_id_for_map = client_id_for_dc.clone();
                
                tokio::spawn(async move {
                    channels_map.lock().await.insert(client_id_for_map, d_clone_for_map);
                });

                d.on_open(Box::new(move || {
                    tracing::info!("[WebRTC Router] Data channel '{}' open for client {}.", d_label, client_id_clone);
                    Box::pin(async {})
                }));

                let tx_clone3 = tx_clone2.clone();
                d.on_message(Box::new(move |msg: DataChannelMessage| {
                    let tx3 = tx_clone3.clone();
                    let cid = client_id_clone2.clone();
                    let data = msg.data.to_vec();
                    Box::pin(async move {
                        let _ = tx3.send((cid, data)).await;
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
