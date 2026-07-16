# 🧪 Automated Verification & Testing Pipeline

Because this project is a highly complex, GPU-accelerated simulation with real-time networking, manual testing of performance, networking constraints, and memory management is incredibly tedious and error-prone. 

To guarantee the engine remains rock solid, we use **Playwright** to execute a suite of headless End-to-End (E2E) regression tests against the frontend.

---

## 🚀 Running the Frontend E2E Suite

The E2E tests are organized under the `tests/` directory:
- `tests/e2e/` - Contains the Playwright and Puppeteer integration tests (e.g., `puppeteer_test.js`)
- `tests/unit/` - Contains isolated unit tests (e.g., `test-frustum.mjs`)

To execute the core E2E suite:

1. Ensure your local `vite` development server is running in one terminal:
   ```bash
   npm run dev
   ```
2. In a second terminal, execute the desired test file. For example:
   ```bash
   node tests/e2e/puppeteer_test.mjs
   ```

*(The suite will automatically launch a headless browser instance, run the verifications, and report the results).*

---

## 🛠️ Automated E2E Test Coverage

The suite strictly enforces 5 core pillars of the engine's functionality:

### 1. Multiplayer Stress Testing (AOI Bot Swarms)
*   **What it does:** Spawns 10 complete headless browser contexts simultaneously and points them all to the simulation.
*   **Why we automate it:** Validates that our **Area of Interest (AOI) Spatial Filtering** in the Rust server correctly multiplexes and isolates WebRTC `Float32Array` payloads across a swarm of concurrent peers without dropping connections.

### 2. Precise FPS & Performance Regression
*   **What it does:** Hooks into the raw Chrome DevTools Protocol (CDP) API (`Performance.getMetrics`) to mathematically average the true frames rendered over exactly 2 seconds of GPU processing time.
*   **Why we automate it:** Automatically blocks commits that introduce unoptimized WGSL shaders or heavy geometry that drops the client framerate below the strict 60 FPS threshold (with a 10% tolerance margin).

### 3. V8 Memory Leak Detection
*   **What it does:** Triggers the Babylon.js Dynamic Terrain geomorphing logic by forcefully simulating 20 aggressive zoom-in and zoom-out cycles via mouse-wheel emulation. It then forces a V8 Garbage Collection (`window.gc()`) and measures the `usedJSHeapSize`.
*   **Why we automate it:** Ensures the quadtree tile system properly disposes of orphaned materials, meshes, and textures, strictly failing the test if the heap footprint permanently grows by > 50MB.

### 4. Pixel-Perfect Visual Diffing
*   **What it does:** Locks the virtual Babylon.js camera to a precise mathematical coordinate `(0, 1000, 0)` looking at `(100, 500, 100)`. It extracts a screenshot of the canvas and calculates a pixel-by-pixel mathematical diff against a known good baseline image.
*   **Why we automate it:** Verifies that our complex Glacial Shearing normal maps and directional lighting calculations render identically across updates.

### 5. WebGPU Fallback Verification
*   **What it does:** Forcefully spins up a browser instance that lacks the `--enable-unsafe-webgpu` runtime flag.
*   **Why we automate it:** Guarantees that our graceful degradation logic functions flawlessly, successfully swapping the context to the `WebGL 2` fallback engine and firing the UI warning banner.

### 6. WebRTC Server Meshing Integration
*   **What it does:** Uses a custom Playwright evaluation script to manually perform a full WebRTC STUN/ICE handshake over the secure control WebSocket, opens the `player_telemetry` DataChannel, and asserts the successful reception of the native 16,384-byte float array.
*   **Why we automate it:** Provides full end-to-end integration coverage for our Server-to-Peer architecture, ensuring that binary physics payloads correctly route through our UDP channels without TCP head-of-line blocking.

### 7. LocalStorage DB Re-hydration
*   **What it does:** Injects known configuration values into the browser's `localStorage`, forces a complete page reload, and asserts that the environment rehydrates correctly from the persistent cache without data loss.
*   **Why we automate it:** Guarantees that user-defined configurations (such as customized landmark weather pins) persist across browser sessions.

### 8. UI Telemetry (ControlMessage JSON)
*   **What it does:** Synthesizes a raw telemetry event from the client and captures the outbound payload, verifying that it aligns perfectly with the backend's strict `ControlMessage` JSON schema.
*   **Why we automate it:** Ensures the frontend correctly marshals user actions (like slider changes for time or weather) into the precise format required by the Axum server.

### 9. Mobile Viewport & Dynamic Resizing
*   **What it does:** Shrinks the Playwright viewport from 1080p desktop dimensions down to 375x667 (iPhone SE) on the fly, verifying that the `canvas` height naturally adjusts to the `60vh` rule and prevents the 3D context from clipping underneath the UI dashboard.
*   **Why we automate it:** Ensures a functional and aesthetic layout constraint on mobile devices, confirming that responsive CSS queries fire correctly.

---

## ⚙️ Backend Unit Tests (Cargo)

### Docker Environment Setup
Our backend testing uses `testcontainers` to dynamically spin up an isolated ScyllaDB container for database integration testing. This requires a functioning Docker environment with appropriate kernel features enabled for Scylla's I/O engine.

#### 1. Docker Permissions
Ensure your user has permission to interact with the Docker daemon without `sudo`:
```bash
sudo usermod -aG docker $USER
newgrp docker # Apply group changes immediately
```

#### 2. Kernel Asynchronous I/O (AIO) Configuration
ScyllaDB heavily relies on Linux AIO for high-performance disk access. Standard OS limits are often too low and will cause the `test_scylladb_meshing_registry` container to fail on boot.

**Linux (Debian/Ubuntu, RHEL/CentOS, Arch):**
You must permanently increase the `fs.aio-max-nr` limit to `1048576` or higher.
```bash
# Temporarily apply for the current session
sudo sysctl -w fs.aio-max-nr=1048576

# Permanently apply across reboots
echo "fs.aio-max-nr = 1048576" | sudo tee -a /etc/sysctl.d/99-scylla.conf
sudo sysctl -p /etc/sysctl.d/99-scylla.conf
```

**macOS & Windows (Docker Desktop / Colima / OrbStack):**
*   **Not Applicable / Automatic**: macOS and Windows don't natively run Docker containers; instead, they run them inside a lightweight Linux VM (managed by Docker Desktop, WSL2, or OrbStack). This VM generally pre-configures AIO capabilities out of the box, or bypasses standard kernel limits. You typically do **not** need to set this configuration.

### Running the Backend Suite
```bash
cd rust-engine/
cargo test --all-targets
```

### 1. Core Physics Execution Logic
The suite actively asserts the logic of the `ExecutionMode` engine in `physics/src/lib.rs`:
*   **`test_physics_solver_compiles`**: Verifies that the native WebGPU pipeline and `wgpu` module structure compiles correctly even in a headless CI environment without an active display adapter (vulkan/metal).
*   **`test_meshing_mode_logic`**: Exhaustively tests the `determine_execution_mode` tri-state branch. It mathematically guarantees the engine correctly falls back to `Tiled` compute when huge buffers exceed VRAM limits, and strictly respects the `FORCE_MESHING` environment overrides (Auto/True/False). This ensures that server meshing and Iterative Tiled Compute mode fail-safes trigger exactly when expected, preventing out-of-memory crashes on massive maps.

### 2. Server Meshing & Database Integration
*   **`test_scylladb_meshing_registry`**: Boots up a full, real ScyllaDB docker container dynamically via `testcontainers` to test live interactions. It verifies that we can correctly negotiate, claim, serialize, and read/write raw blob buffers (`Vec<u8>`) to the `weather_sim.tiles` table.

### 3. GPU Computation & Engine Integration
We maintain strict parity with our original legacy mathematical algorithms. These tests run directly through our async `tokio` runtime to verify correctness:
*   **`test_websocket_control_settings`**: Verifies that our native Axum WebSockets flawlessly parse and strictly map to the legacy JSON configuration API.
*   **`test_weather_physics_instantiation`**: Dynamically loads our true native `weather_compute.wgsl` disk asset to aggressively validate the WGSL syntax and memory binding layouts across the pipeline.
*   **`test_weather_physics_update` & `test_hydrology_solver`**: Ensure no pipeline panics occur during high-frequency execution cycles.
*   **`test_cpu_gpu_consistency`**: Verifies absolute GPU determinism. Identical mathematical grid seeds natively routed through our `wgpu` stack must always execute with identical physics results across our entire WebRTC node cluster.

### 4. Node-to-Node P2P Networking
*   **`test_p2p_mesh_datachannel`**: An async native Rust integration test that validates our true Server-to-Server P2P architecture. It spins up two isolated Rust WebRTC instances (Node A and Node B), mimics passing their cryptographic SDP Offers through the registry, triggers the active dialer `create_data_channel` logic, and successfully negotiates a direct UDP pipeline via STUN/ICE. It mathematically asserts that a 16,384-byte boundary float array is perfectly transmitted and received entirely Peer-to-Peer without passing through a central server or browser.
