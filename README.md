# Middle-earth Weather Simulator (me-weather)

An interactive, GPU-accelerated client-server weather simulator of Middle-earth. It simulates thermodynamics, fluid dynamics, and terrain-climate interactions across massive high-resolution grids in real-time, delivering dynamic wind flows, precipitation, temperature variations, and moisture indices.

![Middle-earth Weather Simulator Screenshot](screenshot_2.png)

---

## ✨ Features

### 🌍 World & Terrain
*   **Server-Side Terrain Support**: The backend serves master elevation maps (`heightmap_coarse.png` / `normalmap_coarse.png`) and dynamically slices high-res tiles on startup to ensure data integrity.
*   **Custom Terrain Shader**: Renders a 3D displaced terrain mesh in WebGPU / WebGL 2 (Babylon.js). Toggling the *Moisture overlay* flows smooth royal blue vapor directly over the geographic terrain colors.
*   **Landmarks & Custom Pins**: Weather stations render 3D rings at their exact terrain elevation. Right-click to place custom map pins that automatically persist across page reloads via `localStorage`.

### 🚀 Performance & Graphics
*   **Iterative Tiled Compute Mode**: If grid memory exceeds WebGPU limits, the physics solver seamlessly falls back to streaming 4096x4096 chunked tiles sequentially to the GPU—enabling infinitely large maps without VRAM crashes.
*   **Volumetric 3D Clouds**: Renders 6,000 additive-blended vapor points that drift dynamically with local wind vectors and cluster realistically in high-humidity zones (moisture $\ge 55\%$).
*   **Client-Side WebGPU Culling**: Offloads frustum chunk visibility math from the CPU to a native WebGPU Compute Shader (`cull.wgsl`), processing thousands of tile bounding boxes in parallel.
*   **Dynamic Camera Fitting**: Overhead view dynamically recalculates camera height based on FOV and viewport aspect ratio, guaranteeing the massive map perfectly fits on resize without UI overlap.

### ⚡ Networking & Backend Architecture
*   **Unified Client-Server Process**: A monolithic Rust Axum server orchestrates the entire physics simulation, WebSockets, and natively hosts the compiled Vite client assets from a single port.
*   **WebGPU Native Compute (`wgpu-rs`)**: Sync-requests Vulkan/EGL adapters natively on the host server, directly executing atmospheric compute shaders on backend GPU hardware with zero overhead.
*   **Dynamic Server Meshing**: Uses ScyllaDB as a decentralized boundary-registry. Multiple physical servers can dynamically claim tiles based on their available VRAM, natively executing compute in parallel and exchanging edge boundary data to simulate entire continents.
*   **Quantized Binary Telemetry**: Streams data over binary WebSockets (and UDP WebRTC DataChannels) packed tightly into quantized Float16 ArrayBuffers, drastically cutting bandwidth and eliminating JSON parsing stalls.
*   **Server-Authoritative Collision**: Employs a hybrid 2D heightmap array and 3D Rust Octree collision system to mathematically validate all movement in real-time, preventing clients from cheating or teleporting.

---

## 🛠️ Technology Stack

*   **Vite & Vanilla JavaScript (ES6)** — Client-side bundler and UI controller.
*   **Babylon.js (WebGPU / WebGL 2)** — Client-side 3D terrain rendering and dynamic weather systems.
*   **Rust & Axum** — Blazing-fast backend REST server and Game State Authority WebSockets.
*   **WebAssembly (wasm-bindgen)** — Client-side spatial math and Delta Movement Culling bypassing JS garbage collection.
*   **webrtc-rs** — Massive-scale UDP DataChannel routing for low-latency peer data.
*   **wgpu-rs** — Native backend physics engine executing WebGPU atmospheric compute shaders with zero overhead.
*   **ScyllaDB** — Distributed database acting as a high-speed central registry for Dynamic Server Meshing and 5-minute persistent world-state snapshots.

---

## 📂 Project File Structure

<details>
<summary>Click to expand</summary>

```text
me-weather/
├── .agents/                 # Internal configs and agent rules
│   ├── rules/               # Markdown-based coding style and convention rules
│   │   ├── license-headers  # Enforces MIT license injection on new files
│   │   └── puppeteer-cleanup # Ensures lingering Playwright/browser processes are killed
│   └── skills/              # Specialized agent instruction sets
│       ├── clean-docker     # Instructions for purging unused database containers
│       └── stride-linting   # Threat modeling and security auditing framework
├── public/                  # Static assets served by Vite
├── rust-engine/             # Cargo workspace containing all Rust backend microservices
│   ├── physics/             # Native WebGPU atmospheric compute shader execution engine
│   ├── server/              # Axum REST server and WebSocket simulation orchestrator
│   ├── tile-server/         # High-speed ScyllaDB tile registry and dynamic server meshing
│   ├── wasm-math/           # WebAssembly bindings for client-side spatial calculations
│   └── webrtc-router/       # UDP DataChannel router for low-latency peer data streams
├── server/                  # Python asset processing scripts and static data storage
│   ├── assets/              # Master maps, weather textures, and dynamically generated quadtree tiles
│   │   ├── flowmap.png          # Generated 2D fluid vectors for WebGPU particles
│   │   ├── generated-heights/   # Raw 16-bit regional heightmaps extracted from cells
│   │   ├── heightmap.png        # Source of truth 16-bit master elevation map
│   │   ├── normalmap.png        # Source of truth high-res master terrain angle map
│   │   └── tiles/               # Dynamically generated 1024x1024 quadtree mesh sub-tiles
│   ├── build_tiles.py       # QuadTree map slicing and KTX2 compression pipeline script
│   ├── generate_flowmap.py  # Computes 2D fluid vectors from elevation gradients
│   └── height_extractor.py  # Script for extracting heightmaps from cells
├── src/                     # Client-side JavaScript (Vite)
│   ├── main.js              # Application entrypoint and render loop orchestrator
│   ├── renderer.js          # WebGPU Babylon.js environment, camera, and lighting setup
│   ├── terrain.js           # Terrain tile LOD system, geomorphing, and custom shaders
│   ├── physics.js           # WebAssembly thermodynamics and fluid simulation bindings
│   └── ui.js                # Control panel interface and HTML DOM updates
├── tests/                   # Automated E2E Playwright tests and Pytest backend integration tests
├── third_party_licenses/    # Open-source dependency licenses
├── Caddyfile                # Production TLS (HTTPS/WSS) reverse proxy configuration
├── docker-compose.yml       # Docker deployment and testing orchestrator configuration
├── GPU_SOLVER.md            # Documentation for the WebGPU compute shader architecture
├── hostconfig.json          # Container orchestration runtime configuration
├── index.html               # Client HTML layout and interface DOM
├── LICENSE                  # Project licenses
├── package.json             # NPM package and Vite script commands
├── README.md                # This file
├── scylla.yaml              # ScyllaDB initialization configuration
├── STRIDE.md                # Threat modeling assessment
├── TESTING.md               # Automated testing pipeline documentation
├── vite.config.js           # Client bundler configuration
└── WEBRTC_CADDY_SETUP.md    # Production TLS reverse proxy setup guide
```

</details>

---

## 🧪 Testing

For full documentation on our automated backend Pytest regression suite and our headless E2E Playwright performance/memory profiling pipeline, please see [TESTING.md](TESTING.md).

---

## 🚀 Getting Started

Ensure you have [Node.js](https://nodejs.org/) (v18+) and [Rust](https://www.rust-lang.org/tools/install) (v1.85+) installed.
You will also need to install `wasm-pack` globally for the WebAssembly math engine:
```bash
cargo install wasm-pack
```

### 1. Start Local ScyllaDB Node (Optional)

The engine gracefully falls back to isolated memory mode if a database isn't found. However, to enable persistent 5-minute world-state snapshots or multi-node Server Meshing, you must run ScyllaDB locally.

**This is completely automatic!** If the server detects that ScyllaDB is not running, it will programmatically execute the following Docker command, wait 15 seconds for initialization, and automatically retry connecting:

```bash
docker run --name scylla-node -d -p 9042:9042 scylladb/scylla:5.4.0
```
*(If the container is already running, the server connects instantly without waiting. The server will also automatically scaffold the required `weather_sim` keyspace and `tiles` table on its first successful connection).*

### 2. Extracting Terrain Heights (Optional/Experimental)
If you have the source game data files, configure `HEIGHTS_PATH` in `.env` and extract the regional heightmaps using the legacy python script:
```bash
cd server
uv venv .venv
uv pip install -r requirements.txt
.venv/bin/python height_extractor.py --mode extract-regions --region all
```

### 2.5. Environment Art Tile Generation (Required for new maps)
Whenever you update the master `heightmap_coarse.png` or `normalmap_coarse.png` in `server/assets/`, you must rebuild the GPU-optimized KTX2 tiles before launching the client:
```bash
cd server
python build_tiles.py
```
*(This script slices the master maps into QuadTree tiles and super-compresses them into Basis Universal KTX2 format using the `basisu` compiler, which is required for zero-latency WebGL/WebGPU texture streaming.)*

### 3. Launching in Production Mode
This builds the client assets and starts the distributed Rust Axum microservices.

1.  **Build the Client Assets**:
    At the project root directory:
    ```bash
    npm run build
    ```
2.  **Start the Rust Backend Orchestrator**:
    ```bash
    npm run start:rust
    ```
3.  Open `http://localhost:8000` in your web browser.

### 3. Launching in Development Mode
This runs the Rust backend services and the Vite dev server with Hot Module Replacement (HMR).

1.  **Start the Rust Backend Orchestrator**:
    ```bash
    npm run dev:rust
    ```
2.  **Start the Vite Dev Server**:
    In a new terminal window at the project root directory:
    ```bash
    npm run dev
    ```
3.  Open `http://localhost:5173` in your web browser.

---

## ⚙️ Configuration

You can customize the simulation parameters by editing **`.env`**:

```ini
# Terrain asset filenames (relative to server/assets/)
HEIGHTMAP_FILENAME=heightmap.png
NORMALMAP_FILENAME=normalmap.png

# Optional: Directory name containing pre-tiled Gaea/World Machine exports
# (relative to server/assets/)
TILED_IMPORT_DIR=gondor_16k_tiled

# Pause physics loop when no clients are connected (True/False)
PAUSE_ON_IDLE=True

# Enable GPU moisture and hydrology compute shader passes (True/False)
ENABLE_HYDROLOGY=True

# Heights (cell) Installation Path
HEIGHTS_PATH="assets"

# Run the simulation in headless mode (no OS GUI overhead).
# True sets the Iterative Tiled Compute Mode threshold to 95% of VRAM,
# False lowers it to 80% to prevent Desktop Environment crashes.
HEADLESS=False

# GPU VRAM limit in GB.
# If the simulation buffer exceeds the threshold (or WebGPU 2GB per-buffer limit),
# it automatically triggers Iterative Tiled Compute Mode (slower but supports
# infinite map sizes).
GPU_VRAM_GB=8

# Force Dynamic Server Meshing (Auto/True/False).
# Auto: Automatically enables Server Meshing if the grid exceeds VRAM
#       limits.
# True: Forces node to connect to ScyllaDB and sync with cluster, even
#       if map fits.
# False: Prevents node from meshing, even if VRAM limits are exceeded
#        (forces local-only Iterative Tiled Compute when limits exceeded).
FORCE_MESHING=False

# ScyllaDB Native Node Address (CQL Port: 9042)
# Used by the Rust physics orchestrator to perform high-speed binary
# reads/writes for server meshing and tile data.
SCYLLA_URI=127.0.0.1:9042

# ScyllaDB REST API Address (HTTP Port: 10000)
# Strictly used for administrative tasks that the CQL driver cannot perform natively,
# such as triggering and managing automatic world-state snapshots.
SCYLLA_API=http://127.0.0.1:10000

# Snapshot Management
# Controls how many 5-minute persistent world-state snapshots are kept
# in ScyllaDB before older ones are automatically pruned (Minimum: 1).
NUM_SNAPSHOTS=2
```

### 🗂️ Tiled Map Import (Gaea / World Machine / Terraform)
To support massive resolution maps (like 16k+) without triggering OutOfMemory errors when loading giant master files, you can place pre-tiled terrain grids exported from external tools directly into the server assets.

#### 1. Folder Structure:
Create a directory under `server/assets/` (e.g. `server/assets/gondor_16k_tiled/`) structured as follows:
```text
server/assets/gondor_16k_tiled/
├── manifest.json
├── height/
│   ├── tile_x0_y0.png
│   ├── tile_x1_y0.png
│   └── ...
└── normal/
    ├── tile_x0_y0.png
    ├── tile_x1_y0.png
    └── ...
```

#### 2. Manifest Schema (`manifest.json`):
Place a `manifest.json` in the root of the tiled directory matching the following layout:
```json
{
  "name": "gondor_16k_tiled",
  "version": "1.0",
  "totalResolution": 16384,
  "tileSize": 4096,
  "gridSize": 4,
  "fileFormat": "png",
  "tileNamingPattern": "tile_x{x}_y{y}.png"
}
```
*   `totalResolution`: Total pixel width/height of the stitched terrain map.
*   `tileSize`: Pixel width/height of individual source tiles (e.g., 4096).
*   `gridSize`: Number of tiles on each axis (e.g., 4 to make a 4x4 grid of 16k total).
*   `tileNamingPattern`: Filename naming pattern matching Gaea coordinate suffix naming.

When active, the server dynamically crops and downsamples coarse maps on startup, and crawls/stitches intersections of the high-resolution source tiles on-the-fly to serve the client-side WebGPU tile request streams on-demand.

---

## 🌐 Browser WebGPU Configuration Guide

By default, the client uses the high-performance **WebGPU** rendering pipeline (via Babylon.js) with a seamless automatic fallback to **WebGL 2** if WebGPU is unsupported or disabled by the browser. 

Use the following settings to configure native WebGPU on your operating system:

### 🌍 Google Chrome & Microsoft Edge (Windows / macOS / ChromeOS)
WebGPU is **supported natively and enabled by default** in Chrome and Edge (Version 113+). 
*   No special flags or configuration are required out-of-the-box on Windows, macOS, and ChromeOS.
*   **Linux Specific**: Chromium on Linux requires Vulkan. Navigate to `chrome://flags` (or `edge://flags`), search for `#enable-unsafe-webgpu` and `#enable-vulkan`, and set both to **Enabled**.

### 🍎 Safari (macOS & iOS)
WebGPU is supported natively in **Safari 18+** (macOS Sequoia / iOS 18) and **Safari Technology Preview**.
*   In older versions (Safari 17), you must explicitly enable it: Go to **Safari > Settings > Advanced**, check "Show Develop menu". Then go to **Develop > Feature Flags**, and check **WebGPU**.
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
> You may see validation warnings in the console during startup (e.g., `Shader module creation failed: Shader validation error` for `CopyVideoToTexture`). These are harmless browser-level compilation errors originating from Firefox's ongoing `wgpu`/`naga` integration. Because our application does not use video textures, these shaders are never executed, and they have zero impact on rendering stability or performance.

---

## 🔒 Production Deployment & TLS (Caddy)

For a production-ready deployment, browsers require a secure origin (HTTPS/WSS) to enable advanced web features such as WebRTC Data Channels. To run this simulation in a secure production context with minimal overhead and complexity, we utilize **Caddy** as a TLS termination reverse proxy.

### Why Caddy?
*   **Automatic TLS**: Caddy automatically provisions and renews SSL certificates (via Let's Encrypt / ZeroSSL) with zero manual intervention or cron jobs.
*   **High Performance**: Offloads encryption/decryption overhead to Caddy's high-speed Go network layer, preserving 100% of our Rust backend's CPU power for WebGPU/physics simulation execution.
*   **WebSocket Upgrades**: Natively handles connection upgrades for the multiplexed control and stream sockets.

### Localhost vs. Production TLS
*   **Production**: Caddy dynamically queries Let's Encrypt/ZeroSSL to provision and manage standard public SSL certificates.
*   **Localhost Development**: Caddy automatically installs and trusts a local self-signed root certificate in your operating system's trust store. This allows you to test full production-identical HTTPS and WSS locally without needing public cert provisioning or domains.

For the full architectural setup and optimized TLS 1.3 configurations, refer to the [WEBRTC_CADDY_SETUP.md](WEBRTC_CADDY_SETUP.md) guide.
