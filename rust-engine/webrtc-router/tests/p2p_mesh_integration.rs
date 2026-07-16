use std::sync::Arc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::interceptor::registry::Registry;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use tokio::sync::mpsc;
use std::time::Duration;

#[tokio::test]
async fn test_p2p_mesh_datachannel() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Setup WebRTC APIs for Node A and Node B
    let mut m_a = MediaEngine::default();
    m_a.register_default_codecs()?;
    let mut registry_a = Registry::new();
    registry_a = register_default_interceptors(registry_a, &mut m_a)?;
    let api_a = Arc::new(APIBuilder::new().with_media_engine(m_a).with_interceptor_registry(registry_a).build());

    let mut m_b = MediaEngine::default();
    m_b.register_default_codecs()?;
    let mut registry_b = Registry::new();
    registry_b = register_default_interceptors(registry_b, &mut m_b)?;
    let api_b = Arc::new(APIBuilder::new().with_media_engine(m_b).with_interceptor_registry(registry_b).build());

    // Use empty ICE servers for local testing
    let config = RTCConfiguration {
        ..Default::default()
    };

    let pc_a = Arc::new(api_a.new_peer_connection(config.clone()).await?);
    let pc_b = Arc::new(api_b.new_peer_connection(config.clone()).await?);

    // 2. Node A creates the DataChannel (Acting as the initiator)
    let dc_a = pc_a.create_data_channel("mesh_boundary", None).await?;
    
    let (tx_b, mut rx_b) = mpsc::channel::<Vec<u8>>(10);
    
    // Node B listens for the incoming DataChannel
    pc_b.on_data_channel(Box::new(move |d: Arc<webrtc::data_channel::RTCDataChannel>| {
        let tx = tx_b.clone();
        d.on_message(Box::new(move |msg: DataChannelMessage| {
            let tx2 = tx.clone();
            let data = msg.data.to_vec();
            Box::pin(async move {
                let _ = tx2.send(data).await;
            })
        }));
        Box::pin(async {})
    }));

    // 3. Signaling (Mocking ScyllaDB Exchange)
    
    // Node A creates Offer
    let offer = pc_a.create_offer(None).await?;
    let mut gather_complete_a = pc_a.gathering_complete_promise().await;
    pc_a.set_local_description(offer).await?;
    let _ = gather_complete_a.recv().await;
    
    // Node B receives Offer, creates Answer
    let offer_sdp = pc_a.local_description().await.unwrap();
    pc_b.set_remote_description(offer_sdp).await?;
    
    let answer = pc_b.create_answer(None).await?;
    let mut gather_complete_b = pc_b.gathering_complete_promise().await;
    pc_b.set_local_description(answer).await?;
    let _ = gather_complete_b.recv().await;
    
    // Node A receives Answer
    let answer_sdp = pc_b.local_description().await.unwrap();
    pc_a.set_remote_description(answer_sdp).await?;

    // Wait for connection to establish
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 4. Node A streams physics boundary to Node B
    // A 4096 Float32 array is 16384 bytes
    let boundary_data = vec![42u8; 16384];
    dc_a.send(&bytes::Bytes::from(boundary_data.clone())).await?;

    // 5. Node B validates the boundary receipt
    if let Some(received) = tokio::time::timeout(Duration::from_secs(2), rx_b.recv()).await.ok().flatten() {
        assert_eq!(received.len(), 16384);
        assert_eq!(received, boundary_data);
        tracing::info!("✅ Server Meshing P2P DataChannel perfectly streamed 16KB boundary over native UDP!");
    } else {
        panic!("P2P DataChannel timeout!");
    }

    Ok(())
}
