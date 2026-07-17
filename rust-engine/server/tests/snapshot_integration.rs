// snapshot_integration.rs (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

use testcontainers::{runners::AsyncRunner, GenericImage, ImageExt, core::Mount};
use std::time::Duration;

#[tokio::test]
async fn test_scylladb_snapshot_pruning() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let host_scylla_yaml = format!("{}/../../scylla.yaml", manifest_dir);

    // 1. Spin up a real ScyllaDB docker container for snapshot testing
    let scylla_image = GenericImage::new("scylladb/scylla", "2025.1.0")
        .with_entrypoint("/usr/bin/scylla")
        .with_wait_for(testcontainers::core::WaitFor::message_on_stderr("init - serving"))
        .with_mount(Mount::bind_mount(host_scylla_yaml, "/etc/scylla/scylla.yaml"));
        
    let _node = scylla_image.with_cmd(vec![
        "--options-file", "/etc/scylla/scylla.yaml",
        "--smp", "1",
        "--memory", "750M",
        "--developer-mode", "1",
        "--prometheus-port", "0",
        "--api-port", "10001", // Bind API to 10001 to avoid host conflicts
        "--alternator-port", "0",
    ])
    .with_network("host")
    .start()
    .await
    .expect("Failed to start ScyllaDB container");

    // Wait a brief moment for the REST API to become fully ready after "init - serving"
    tokio::time::sleep(Duration::from_secs(5)).await;

    let api_client = reqwest::Client::new();
    let scylla_api = "http://127.0.0.1:10001";
    
    // 2. Validate creating 3 snapshots sequentially via the REST API
    for i in 1..=3 {
        let tag = format!("auto_test_{}", i);
        let url = format!("{}/storage_service/snapshots?tag={}", scylla_api, tag);
        let res = api_client.post(&url).send().await.expect("Failed to invoke snapshot creation API");
        assert!(res.status().is_success(), "Failed to create snapshot {}", tag);
        println!("Successfully created snapshot: {}", tag);
    }

    // 3. Validate our pruning mechanism (Deleting old snapshots)
    let tag_to_delete = "auto_test_1";
    let del_url = format!("{}/storage_service/snapshots?tag={}", scylla_api, tag_to_delete);
    let res = api_client.delete(&del_url).send().await.expect("Failed to invoke snapshot deletion API");
    assert!(res.status().is_success(), "Failed to prune old snapshot");
    println!("Successfully pruned old snapshot: {}", tag_to_delete);
}
