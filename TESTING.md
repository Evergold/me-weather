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
*   **Why we automate it:** Validates that our **Area of Interest (AOI) Spatial Filtering** in the Python server correctly multiplexes and isolates WebRTC `Float32Array` payloads across a swarm of concurrent peers without dropping connections.

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

## ⚙️ Backend Regression Tests (Pytest)

Before the frontend UI was fully integrated, the Python backend (`server/`) was heavily tested using a custom `pytest` suite. This guarantees the mathematical fidelity of the simulation grids and weather solvers.

### Running the Backend Suite
```bash
cd server
./.venv/bin/pytest -v
```

### Automated Backend Test Coverage
The suite actively asserts 5 core simulation properties across `test_physics.py` and `test_api.py`:

1.  **`test_weather_physics_instantiation`**
    *   **What it does:** Verifies that the core `WeatherPhysics` class successfully pre-allocates all large NumPy arrays (temperature, moisture, wind vectors) for a massive $2000 \times 2000$ grid without crashing the server's memory.
2.  **`test_weather_physics_update`**
    *   **What it does:** Runs a single simulation tick and asserts that the resulting float grids do not contain any `NaN` or `Infinity` values, guaranteeing thermal stability.
3.  **`test_hydrology_solver`**
    *   **What it does:** Asserts that the cellular automaton flow-routing algorithm (`HydrologySolver`) successfully accumulates downstream river widths without entering infinite loops on flat terrain.
4.  **`test_cpu_gpu_consistency`**
    *   **What it does:** The most critical test. It executes the exact same atmospheric equations simultaneously on the NumPy CPU fallback and the `wgpu-py` WGSL shader. It then calculates the delta between the two output grids, asserting that the hardware-accelerated GPU math perfectly matches the precise CPU math within an acceptable float tolerance margin ($10^{-5}$).
5.  **`test_websocket_control_settings` (API)**
    *   **What it does:** Uses `FastAPI TestClient` to spin up a mock WebSocket connection to `/ws/control/`. It intercepts the ASGI application lifecycle, sends a simulated JSON UI setting (e.g. `{"timeOfDay": 1200}`), and asserts that the `ConnectionManager` successfully updates the global Python engine variables without dropping the socket connection.
