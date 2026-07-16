use testcontainers::{runners::AsyncRunner, GenericImage, core::ContainerPort};
use scylla::client::session_builder::SessionBuilder;
use std::time::Duration;

#[tokio::test]
async fn test_scylladb_meshing_registry() {
    // 1. Spin up a real ScyllaDB docker container for integration testing
    let scylla_image = GenericImage::new("scylladb/scylla", "5.4.0")
        .with_exposed_port(ContainerPort::Tcp(9042))
        .with_wait_for(testcontainers::core::WaitFor::message_on_stdout("init - Scylla version"));
        
    let node = scylla_image.start().await.expect("Failed to start ScyllaDB container");
    let host_port = node.get_host_port_ipv4(9042).await.unwrap();
    let uri = format!("127.0.0.1:{}", host_port);

    // 2. Connect to the container
    let session = SessionBuilder::new()
        .known_node(&uri)
        .build()
        .await
        .expect("Failed to connect to ScyllaDB container");

    // 3. Setup the meshing keyspace and tables (as main.rs does)
    session.query_unpaged("CREATE KEYSPACE weather_sim WITH REPLICATION = {'class' : 'SimpleStrategy', 'replication_factor' : 1}", &[]).await.unwrap();
    session.query_unpaged("CREATE TABLE weather_sim.tiles (tile_id text PRIMARY KEY, data blob, last_updated timestamp)", &[]).await.unwrap();

    // 4. Verify we can claim and update a tile
    let tile_id = "tile_4096_0_0";
    let dummy_data = vec![0u8; 128]; // Fake Float32Array blob
    
    session.query_unpaged(
        "INSERT INTO weather_sim.tiles (tile_id, data, last_updated) VALUES (?, ?, toTimestamp(now()))",
        (tile_id, &dummy_data)
    ).await.expect("Failed to insert tile data");
    
    // 5. Query it back to ensure synchronization
    let result = session.query_unpaged("SELECT data FROM weather_sim.tiles WHERE tile_id = ?", (tile_id,)).await.unwrap();
    let rows = result.into_rows_result().unwrap().rows().unwrap();
    assert_eq!(rows.len(), 1, "Expected exactly 1 tile row");
}
