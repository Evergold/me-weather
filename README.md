# Middle-earth Weather Simulator (ME-Weather)

An interactive, GPU-accelerated client-server weather simulator of Middle-earth. It simulates thermodynamics, fluid dynamics, hydrology routing, and terrain-climate interactions across massive high-resolution grids in real-time, delivering dynamic wind flows, precipitation, temperature variations, and moisture indices.

![Middle-earth Weather Simulator Screenshot](screenshot_2.png)

---

## ✨ Features

*   **Server-Side Terrain Map Support**: The server holds and serves the master elevation maps, dynamically slicing them into standard quadtree tiles on startup (with testing completed at 8k/16k resolutions). If maps are missing, the server halts startup to ensure integrity.
*   **Unified Client-Server Process**: A Python FastAPI server serves the physics simulation and WebSocket telemetry channel, while also serving the compiled Vite client assets from the same process on port `8000`.
*   **WebGPU 3D Client Renderer**: Built with WebGPU and Three.js, rendering a dynamic 3D displaced terrain mesh, volumetric sky raymarching, glowing landmark pins, and screen-space weather particles.
*   **GPU-Agnostic Cross-Platform Simulation**: The Python server utilizes standalone WebGPU (`wgpu-py` / WGSL) to run progressive simulation steps. It is GPU-agnostic (NVIDIA, AMD, Intel, Apple) and cross-platform (Windows, Linux, macOS) with a vectorized NumPy CPU fallback.
*   **Dynamic Hydrology**: Dynamic flow routing calculations run on CPU worker pools. Rainwater aggregates and flows downhill to carve riverbeds and form pooling basins in real-time.
*   **Configurable WebSocket Sync**: WebSocket streaming uses quantized Float16 binary ArrayBuffers for low latency. Delivery rates are client-configurable (real-time, 250ms, 500ms, 1000ms).
*   **Dynamic sub-stepping**: Automatically scales simulation time steps based on wind speeds to prevent numerical explosions.
*   **WebGL 2 Fallback**: Devices without WebGPU support silently degrade to WebGL 2 / 2D Canvas rendering to remain functional.

---

## 🛠️ Technology Stack

*   **Vite & Vanilla JavaScript (ES6)** — Client-side bundler and modular UI controllers.
*   **Three.js (WebGL/WebGPU)** — Client-side 3D terrain rendering, lighting, and particles.
*   **FastAPI & Uvicorn** — Server-side API host, tile streaming, and WebSockets.
*   **wgpu-py & WGSL** — Standalone GPU-agnostic server-side physics compute shaders.
*   **NumPy** — Vectorized arrays and CPU fallback solvers.
*   **uv** — Blazing-fast virtual environment and dependency manager.

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

### 2. Verify Master Terrain Assets
Place your master terrain maps in the server assets folder (the code automatically scales to any size, with 8k–16k being the primary tested range):
*   `server/assets/heightmap.png` (grayscale elevation map)
*   `server/assets/normalmap.png` (RGB normal map)

### 3. Launch the Simulator (Dual-Process Setup)
This runs the FastAPI simulation on port `8000` and the Vite dev server with Hot Module Replacement (HMR) for frontend files on port `5173`.

1.  **Start the Simulation Server**:
    ```bash
    cd server
    .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
    ```
2.  **Start the Vite Frontend Dev Server**:
    In a new terminal window at the project root directory:
    ```bash
    npm run dev
    ```
3.  Open `http://localhost:5173` in your web browser. Any edits made to files in `src/` or `index.html` will hot-reload instantly!

---

## ⚙️ Configuration

You can customize the simulation parameters by editing **`server/.env`**:

```ini

# Terrain asset filenames (relative to server/assets/)
HEIGHTMAP_FILENAME=heightmap.png
NORMALMAP_FILENAME=normalmap.png

# Pause physics loop when no clients are connected (True/False)
PAUSE_ON_IDLE=True

# Run river routing only once every 10s to conserve CPU (True/False)
DECOUPLE_HYDROLOGY=False
```
