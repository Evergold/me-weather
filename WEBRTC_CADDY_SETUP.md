# 🌐 High-Performance WebRTC & Caddy (TLS 1.3) Deployment Guide

This document details the configuration for integrating **WebRTC Data Channels (SCTP over DTLS over UDP)** for real-time player telemetry and server meshing, alongside **Caddy** configured for **maximum TLS handshake performance**.

---

## ⚡ 1. High-Performance TLS Configuration (Caddyfile)

When configuring SSL/TLS for local development and production, we prioritize **latency and throughput (performance)** over legacy backward compatibility. 

By utilizing **TLS 1.3 only** and elliptic curve cryptography, we achieve a **1-RTT (Round Trip Time) handshake** (and support 0-RTT session resumption), significantly speeding up assets/tile loading.

### Optimized `Caddyfile`
Create this file in your project root to run Caddy locally or in production:

```caddy
# Global configuration block for highest performance TLS
{
    tls {
        # Enable TLS 1.3 ONLY (eliminates slow legacy TLS 1.2 handshakes & ciphers)
        protocols tls1.3
        
        # Use X25519 curve for key exchange (fastest key agreement, lowest CPU overhead)
        curves x25519
    }
}

# Production Domain or Localhost
localhost {
    # 1. Compress responses using modern compression algorithms
    encode zstd gzip

    # 2. Serve Vite production assets directly
    root * ./dist
    file_server

    # 3. HTTP Keep-Alive tuning to prevent re-handshaking during tile requests
    # Caddy does this automatically by keeping TCP connections open for subsequent requests.

    # 4. Proxy multiplexed WebSockets to the Rust Actix-Web server
    reverse_proxy /ws/* 127.0.0.1:8000 {
        # Maintain keep-alive connections to backend
        transport http {
            keepalive 30s
        }
    }
    
    # 5. Proxy API endpoints (tiles / heightmaps)
    reverse_proxy /tiles/* 127.0.0.1:8000
    reverse_proxy /assets/* 127.0.0.1:8000
}
```

---

## 🎮 2. WebRTC Data Channel Architecture

WebRTC provides client-server (and server-server) unreliable UDP-like streams. 

Because it is encrypted via mandatory DTLS, it satisfies user privacy requirements automatically without additional TLS overhead. Furthermore, we leverage WebRTC Data Channels for our **server meshing** architecture, allowing horizontally scaled backend instances to stream player states, cross-border interactions, and Iterative Tiled Compute synchronization directly to one another peer-to-peer at high frequency without a central server bottleneck.

### A. Client-Server Connection Flow
```text
  [ CLIENT ]                                     [ SERVER (Rust Actix-Web) ]
      │                                                   │
      │ 1. HTTP Upgrade (WSS)                             │
      ├──────────────────────────────────────────────────>│
      │                                                   │
      │ 2. WS Control Channel Established                 │
      │<─────────────────────────────────────────────────>│
      │                                                   │
      │ 3. Create Peer Connection (ICE / SDP)             │
      │ 4. Send SDP Offer (JSON over WSS)                 │
      ├──────────────────────────────────────────────────>│
      │                                                   │
      │ 5. Generate SDP Answer (JSON over WSS)            │
      │<──────────────────────────────────────────────────┤
      │                                                   │
      │ 6. WebSocket Signaling Channel Closes/Idles       │
      │                                                   │
      │ 7. Establish Direct WebRTC UDP Connection         │
      │<=================================================>│
      │    (SCTP over DTLS over UDP - Port 3478/Dynamic)  │
      │                                                   │
      │ 8. Stream High-Frequency Player Telemetry         │
      │<=================================================>│
```

### B. Server-Server Meshing Flow
WebRTC Data Channels are established between backend instances to maintain a globally synchronized state:
1. When a server instance spins up, it queries ScyllaDB for sibling nodes.
2. It acts as a WebRTC Peer, completing the ICE/SDP handshake with other instances over internal VPC networks.
3. Node-to-node WebRTC channels broadcast `Player Enter/Exit Region` and `Telemetry Handoff` events, allowing players to traverse server boundaries flawlessly without a visible loading screen or connection drop.

---

## 🛠️ 3. Software Components

### A. Rust Backend (`server/src/main.rs`)
To handle WebRTC peer connections in Rust, we use the `webrtc-rs` crate.
1.  **Signaling Handler**: Add a listener on the `/ws/control/{client_id}` endpoint for `{"type": "offer", "sdp": "..."}` messages.
2.  **RTC Peer Connection**: On receiving an offer, initialize a `RTCPeerConnection` instance.
3.  **Data Channel**: Listen for the `@pc.on("datachannel")` event:
    *   Set up a message handler to instantly parse player position bytes using `f32::from_le_bytes` (16 bytes representing $x, y, z, rot$).
4.  **Spatial-Partitioned Telemetry Broadcaster**:
    *   The server broadcasts player telemetry using an improved, decoupled `tokio::task` ticking exactly at 30 FPS.
    *   **Batching & Culling**: It uses distance-based interest management to compile a tight binary payload, culling entities outside of a player's view distance.
    *   **Meshing Integration**: Player states are injected from sibling nodes via the server-to-server WebRTC channels, merged into the local tick loop, and broadcasted to local connected clients simultaneously.
5.  **Send Answer**: Respond with a JSON answer back over the `/ws/control` WebSocket.

### B. Client Frontend (`src/physics.js`)
1.  **Initialize Connection**:
    ```javascript
    this.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    ```
2.  **Create Data Channel**:
    ```javascript
    this.dataChannel = this.pc.createDataChannel("player_telemetry", {
        ordered: false,         // Unordered for raw UDP performance
        maxRetransmits: 0       // Unreliable (0 retransmits) to avoid lag spikes
    });
    ```
3.  **Perform Signaling**: Generate SDP offer, send it via `this.controlWs`, and set the remote description when the server returns the answer. *This process strictly occurs only when a user enters **Ground-Level View**.*
4.  **Send Stream**: Construct a 16-byte `Float32Array` (wrapped in an `ArrayBuffer`) and call `this.dataChannel.send(buffer)` at exactly 30 FPS to push player position updates directly over UDP.
