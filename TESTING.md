# 🧪 Automated Verification & Testing Pipeline

Because this project is a highly complex, GPU-accelerated simulation with real-time networking, manual testing of performance, networking constraints, and memory management is incredibly tedious and error-prone. 

To guarantee the engine remains rock solid, we use **Playwright** to execute a suite of headless End-to-End (E2E) regression tests against the frontend.

---

## 🚀 Running the Frontend E2E Suite

The Playwright suite is located in `tests/e2e.spec.js`. To execute the test suite:

1. Ensure your local `vite` development server is running in one terminal:
   ```bash
   npm run dev
   ```
2. In a second terminal, execute Playwright:
   ```bash
   npx playwright test
   ```

*(Playwright will automatically launch a headless Chromium instance, run the test suites, and report the results).*

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

---

## ⚙️ Backend Unit Tests (Cargo)

The Rust backend engine (`rust-engine/`) is tested using native `cargo test` suites to guarantee mathematical fidelity, buffer configurations, and the execution logic of the physics solver.

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
