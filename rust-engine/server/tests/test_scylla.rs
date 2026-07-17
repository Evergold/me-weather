// test_scylla.rs (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

use testcontainers_modules::{
    testcontainers::runners::AsyncRunner,
    testcontainers::ImageExt,
    scylladb::ScyllaDB,
};
use scylla::client::session_builder::SessionBuilder;

#[tokio::main]
async fn main() {
    println!("Starting ScyllaDB container...");
    let scylla_image = ScyllaDB::default()
        .with_cmd(["--smp", "1", "--memory", "750M", "--developer-mode=1"]);
        
    let node = scylla_image.start().await.expect("Failed to start ScyllaDB container");
    
    let host = node.get_host().await.unwrap();
    let port = node.get_host_port_ipv4(9042).await.unwrap();
    println!("ScyllaDB container started on {}:{}", host, port);
    let uri = format!("{}:{}", host, port);

    // 2. Connect to the container
    let mut session_opt = None;
    for i in 0..60 {
        match SessionBuilder::new().known_node(&uri).build().await {
            Ok(session) => {
                session_opt = Some(session);
                println!("Connected!");
                break;
            }
            Err(e) => {
                println!("Scylla Connection Error (attempt {}): {:?}", i, e);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let session = session_opt.expect("Failed to connect to ScyllaDB container after retries");
    println!("Success!");
}
