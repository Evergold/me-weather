use std::collections::{HashMap, VecDeque};
use std::time::{Instant, Duration};

#[derive(Debug, Clone)]
pub struct NodeMetrics {
    pub average_latency_ms: u64,
    pub tiles_computed: u32,
    pub timeouts: u32,
}

pub struct ClusterManager {
    pub pending_tiles: VecDeque<String>,
    pub in_flight: HashMap<(String, String), Instant>, // (tile_id, node_id) -> start_time
    pub node_ledger: HashMap<String, NodeMetrics>,
    pub timeout_duration: Duration,
}

impl ClusterManager {
    pub fn new(tiles: Vec<String>) -> Self {
        Self {
            pending_tiles: tiles.into_iter().collect(),
            in_flight: HashMap::new(),
            node_ledger: HashMap::new(),
            // Reschedule tiles if not returned within 1 second
            timeout_duration: Duration::from_secs(1), 
        }
    }

    /// Claim a tile for compute. Prioritizes the front of the queue (which may contain rescheduled dropped tiles).
    /// Accounts for node connection latency by throttling how many concurrent tiles a slow node can process.
    pub fn claim_tile(&mut self, node_id: String) -> Option<String> {
        // Dynamic latency-based scheduling
        let in_flight_for_node = self.in_flight.keys().filter(|(_, n)| *n == node_id).count();
        let mut max_concurrent = 4; // Fast nodes can process up to 4 tiles concurrently
        
        if let Some(metrics) = self.node_ledger.get(&node_id) {
            if metrics.average_latency_ms > 500 {
                max_concurrent = 1; // Severely throttle slow nodes to prevent cluster stalling
            } else if metrics.average_latency_ms > 200 {
                max_concurrent = 2; // Gently throttle medium-latency nodes
            }
        }

        if in_flight_for_node >= max_concurrent {
            return None; // Node is at its latency-adjusted capacity
        }

        if let Some(tile) = self.pending_tiles.pop_front() {
            self.in_flight.insert((tile.clone(), node_id), Instant::now());
            Some(tile)
        } else {
            None
        }
    }

    /// Iterates through in-flight tiles, finds any that have exceeded the timeout threshold,
    /// and pushes them back to the *front* of the queue so they are computed immediately by another node,
    /// but leaves the original assignment in in_flight so the existing work is not cancelled.
    pub fn check_timeouts(&mut self) {
        let now = Instant::now();
        let mut timed_out = Vec::new();
        
        for ((tile_id, node_id), start_time) in self.in_flight.iter() {
            if now.duration_since(*start_time) > self.timeout_duration {
                timed_out.push((tile_id.clone(), node_id.clone()));
            }
        }
        
        for (tile_id, node_id) in timed_out {
            // We DO NOT remove it from in_flight, so the slow node can still complete it and be tracked.
            // Instead, we just reset the timer so it doesn't trigger a timeout again next frame.
            if let Some(start_time) = self.in_flight.get_mut(&(tile_id.clone(), node_id.clone())) {
                *start_time = Instant::now();
            }
            
            // Re-queue at the front (highest priority)
            self.pending_tiles.push_front(tile_id);
            
            // Update node penalty metrics
            let metrics = self.node_ledger.entry(node_id).or_insert(NodeMetrics {
                average_latency_ms: 0,
                tiles_computed: 0,
                timeouts: 0,
            });
            metrics.timeouts += 1;
        }
    }

    /// Completes a tile, removes it from in_flight, and updates the connection quality metrics for the node.
    pub fn complete_tile(&mut self, tile_id: &str, node_id: &str) {
        if let Some(start_time) = self.in_flight.remove(&(tile_id.to_string(), node_id.to_string())) {
            let latency = start_time.elapsed().as_millis() as u64;
            let metrics = self.node_ledger.entry(node_id.to_string()).or_insert(NodeMetrics {
                average_latency_ms: 0,
                tiles_computed: 0,
                timeouts: 0,
            });
            
            // Simple moving average
            if metrics.tiles_computed == 0 {
                metrics.average_latency_ms = latency;
            } else {
                metrics.average_latency_ms = (metrics.average_latency_ms * 3 + latency) / 4;
            }
            metrics.tiles_computed += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claim_and_complete() {
        let mut cluster = ClusterManager::new(vec!["tile_1".to_string(), "tile_2".to_string()]);
        
        let tile = cluster.claim_tile("node_A".to_string()).unwrap();
        assert_eq!(tile, "tile_1");
        assert_eq!(cluster.in_flight.len(), 1);
        
        cluster.complete_tile("tile_1", "node_A");
        assert_eq!(cluster.in_flight.len(), 0);
        
        let metrics = cluster.node_ledger.get("node_A").unwrap();
        assert_eq!(metrics.tiles_computed, 1);
    }

    #[test]
    fn test_timeout_rescheduling() {
        let mut cluster = ClusterManager::new(vec!["tile_1".to_string()]);
        cluster.timeout_duration = Duration::from_millis(10); // super short timeout for test
        
        cluster.claim_tile("node_B".to_string()).unwrap();
        assert_eq!(cluster.pending_tiles.len(), 0);
        
        std::thread::sleep(Duration::from_millis(20));
        
        cluster.check_timeouts();
        
        // Tile should be back in the queue
        assert_eq!(cluster.pending_tiles.len(), 1);
        assert_eq!(cluster.in_flight.len(), 1); // Existing work is not cancelled
        
        // Node B should have a penalty
        let metrics = cluster.node_ledger.get("node_B").unwrap();
        assert_eq!(metrics.timeouts, 1);
    }
}
