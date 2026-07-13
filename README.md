# Middle-earth Weather Simulator (me-weather)

An interactive, GPU-accelerated client-server weather simulator of Middle-earth. It simulates thermodynamics, fluid dynamics, and terrain-climate interactions across massive high-resolution grids in real-time, delivering dynamic wind flows, precipitation, temperature variations, and moisture indices.

![Middle-earth Weather Simulator Screenshot](screenshot_2.png)

---

## ✨ Features

*   **Server-Side Terrain Map Support**: The server holds and serves the master elevation maps (`heightmap_coarse.png` and `normalmap_coarse.jpg`). It dynamically slices high-res tiles on startup. If assets are missing, the server halts startup to ensure data integrity.
*   **Unified Client-Server Process**: In production mode, the Python FastAPI server serves the physics simulation and WebSocket telemetry channel on port `8000`, while directly mounting and hosting the compiled Vite client assets (`dist/`) from the same port.
*   **Vectorized & Cached CPU Fallback**: Runs the high-resolution grid simulation steps on a background OS worker thread (`asyncio.to_thread`), freeing the FastAPI event loop. Large mesh grids, latitudinal heating factors, and Coriolis constants are pre-allocated and cached in memory, boosting NumPy performance by over 300%.
*   **WebGPU Compute Buffer Setup**: Sync-requests Vulkan/EGL adapters and devices natively on the host server via `wgpu-py`, allocating and uploading simulation buffers for native hardware execution.
*   **Volumetric 3D Cloud Particles**: Renders 6,000 large, additive-blended vapor points on the client browser. The cloud points float at varying volumetric heights, drift dynamically with local wind vectors, and cluster exclusively in high-humidity areas (moisture $\ge 55\%$) for realistic atmospheric depth.
*   **Custom Terrain Shader**: Renders a 3D displaced terrain mesh in WebGL (Three.js). Toggling the **Moisture overlay** overlays a smooth, royal blue vapor flow on top of the green and rocky geographic terrain colors, matching the prototype visual style.
*   **Overhead & Perspective Camera Fitting**: Overhead view dynamically calculates camera heights based on the camera FOV and current viewport aspect ratio to guarantee the 2000x2000 map fits perfectly on resize, while preserving the visibility of the control sidebar.
*   **Quantized Binary Telemetry**: Streams data over binary WebSockets packed into quantized Float16 ArrayBuffers, reducing network bandwidth and avoiding JSON parsing overhead on the client.
*   **Landmarks & Custom Pins**: Landmark weather stations render rings at their correct 3D terrain height. Custom user pins can be placed with a right-click and persist across page loads using `localStorage`.

---

## 🛠️ Technology Stack

*   **Vite & Vanilla JavaScript (ES6)** — Client-side bundler, state manager, and UI controller.
*   **Babylon.js (WebGPU / WebGL 2)** — Client-side 3D terrain rendering, real-time light cycles, dynamic weather systems, and fallback systems.
*   **FastAPI & Uvicorn** — Server-side API host, static asset delivery, and WebSockets.
*   **wgpu-py** — Native WebGPU context and compute buffer management on the server.
*   **NumPy** — Vectorized grid arrays and CPU background solvers.
*   **uv** — Fast Python dependency installer and virtual environment manager.

---

## 🚀 Getting Started

Ensure you have [Node.js](https://nodejs.org/) (v18+) and [Python](https://www.python.org/) (v3.10+) installed.

### 1. Set Up the Python Environment
Install `uv` (if not already installed) and set up the virtual environment:
```bash
cd server
uv venv .venv
uv pip install -r requirements.txt
```

### 2. Extracting Terrain Heights (Optional/Experimental)
If you have the source game data files, configure `HEIGHTS_PATH` in `.env` and extract the regional heightmaps:
```bash
cd server
.venv/bin/python height_extractor.py --mode extract-regions --region all
```
Generated heightmaps are saved in `server/assets/generated-heights/`.

### 3. Launching in Production Mode (Single-Process Setup)
This compiles the frontend assets and runs both the FastAPI backend and the client web app together on port `8000`.

1.  **Build the Client Assets**:
    At the project root directory:
    ```bash
    npm run build
    ```
2.  **Start the Unified Server**:
    ```bash
    cd server
    .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
    ```
3.  Open `http://localhost:8000` in your web browser.

### 4. Launching in Development Mode (Dual-Process Setup)
This runs the FastAPI backend on port `8000` and the Vite dev server with Hot Module Replacement (HMR) on port `5173`.

1.  **Start the Simulation Server**:
    ```bash
    cd server
    .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
    ```
2.  **Start the Vite Dev Server**:
    In a new terminal window at the project root directory:
    ```bash
    npm run dev
    ```
3.  Open `http://localhost:5173` in your web browser. Any edits made to files in `src/` or `index.html` will hot-reload instantly.

---

## ⚙️ Configuration

You can customize the simulation parameters by editing **`.env`**:

```ini
# Terrain asset filenames (relative to server/assets/)
HEIGHTMAP_FILENAME=heightmap.png
NORMALMAP_FILENAME=normalmap.png

# Pause physics loop when no clients are connected (True/False)
PAUSE_ON_IDLE=True

# Run river routing only once every 10s to conserve CPU (True/False)
DECOUPLE_HYDROLOGY=False

# Heights (cell) Installation Path
HEIGHTS_PATH="assets"
```

---

## 🌐 Browser WebGPU Configuration Guide

By default, the client uses the high-performance **WebGPU** rendering pipeline (via Babylon.js) with a seamless automatic fallback to **WebGL 2** if WebGPU is unsupported or disabled by the browser. 

Use the following settings to configure native WebGPU on your operating system:

### 🦁 Brave Browser (Windows / macOS / Linux)
Brave's default shields and fingerprinting protections block WebGPU adapter access.
1.  **Toggle Shields Off**: Click the lion icon in the address bar and toggle **Shields to "Down" (Off)** for `http://localhost:5173` (or `http://localhost:8000`). This stops WebGL warning spam and allows Brave to query WebGPU hardware adapter info.
2.  **Brave Flags**: Navigate to `brave://flags` in your address bar:
    *   **All Platforms**: Search for `#enable-unsafe-webgpu` and set it to **Enabled**.
    *   **Linux Specific**: Search for `#enable-vulkan` and set it to **Enabled** (Vulkan is required for WebGPU in Chromium on Linux).
    *   *(Note: Windows and macOS use their native Direct3D 12 and Metal backends automatically. Do NOT enable Vulkan on Windows or macOS.)*
3.  Relaunch Brave.

### 🦊 Firefox (Nightly, Developer Edition, & Release)
> [!IMPORTANT]
> **Firefox Nightly or Developer Edition** is highly recommended. These are currently the only Firefox channels with stable, active updates to the WebGPU/WGSL shader compiler (`naga`). On standard Firefox Release channels (across Windows, macOS, and Linux), WebGPU remains disabled by default.

To enable and configure WebGPU in Firefox:
1.  Navigate to **`about:config`**.
2.  Set **`dom.webgpu.enabled`** to `true`.
3.  Set **`gfx.webgpu.force-enabled`** to `true`.
4.  Configure **`dom.webgpu.wgpu-backend`** based on your OS:
    *   **Linux**: Set to **`vulkan`** (highly recommended for Linux graphics drivers).
    *   **Windows**: Set to **`d3d12`** (forces DirectX 12).
    *   **macOS**: Set to **`metal`** (forces Apple Metal).
    *   *Alternatively, reset/leave this preference blank to let Firefox auto-select the best API.*
5.  *(Optional)* Go to `about:support` and verify that **Compositing** displays hardware-accelerated **`WebRender`**. If it displays *Software*, set **`gfx.webrender.all`** to `true` in `about:config` to force hardware acceleration.

> [!NOTE]
> **Firefox WebGPU Validation Warnings:**
> You may see validation warnings in the console during startup (e.g., `Shader module creation failed: Shader validation error` for `CopyVideoToTexture`). These are harmless browser-level compilation errors originating from Firefox's ongoing `wgpu`/`naga` integration. Because our application does not use video textures, these shaders are never executed, and they have zero impact on rendering stability or performance.
