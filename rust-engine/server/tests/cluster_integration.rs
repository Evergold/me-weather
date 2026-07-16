use testcontainers::{runners::AsyncRunner, GenericImage, ImageExt, core::Mount};
use scylla::client::session_builder::SessionBuilder;

#[tokio::test]
async fn test_scylladb_meshing_registry() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let host_scylla_yaml = format!("{}/../../scylla.yaml", manifest_dir);

    // 1. Spin up a real ScyllaDB docker container for integration testing
    let scylla_image = GenericImage::new("scylladb/scylla", "2025.1.0")
        .with_entrypoint("/usr/bin/scylla")
        .with_wait_for(testcontainers::core::WaitFor::message_on_stderr("init - serving"))
        .with_mount(Mount::bind_mount(host_scylla_yaml, "/etc/scylla/scylla.yaml"));
        
    let _node = scylla_image.with_cmd(vec![
        "--options-file", "/etc/scylla/scylla.yaml",
        "--log-to-stdout", "1",
        "--network-stack", "posix",
        "--developer-mode=1",
        "--overprovisioned",
        "--smp", "1",
        "--memory", "750M",
        "--listen-address", "127.0.0.1",
        "--rpc-address", "127.0.0.1",
        "--broadcast-rpc-address", "127.0.0.1",
        "--seed-provider-parameters", "seeds=127.0.0.1",
        "--prometheus-port", "0",
        "--api-port", "0"
    ])
    .with_network("host")
    .start().await.expect("Failed to start ScyllaDB container");
    
    let host_port = 9042;
    let uri = format!("127.0.0.1:{}", host_port);

    // 2. Connect to the container (with retry loop as Scylla takes a few seconds to boot CQL)
    let mut session_opt = None;
    for i in 0..40 {
        match SessionBuilder::new()
            .known_node(&uri)
            .connection_timeout(std::time::Duration::from_secs(3))
            .build().await {
            Ok(session) => {
                println!("Connected to Scylla on attempt {}", i);
                session_opt = Some(session);
                break;
            }
            Err(e) => {
                println!("Scylla Connection Error (attempt {}): {:?}", i, e);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let session = session_opt.expect("Failed to connect to ScyllaDB container after retries");

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
    let rows: Vec<(Vec<u8>,)> = result.into_rows_result().unwrap().rows::<(Vec<u8>,)>().unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(rows.len(), 1, "Expected exactly 1 tile row");
}
