# ⚡ Server-Side WebGPU / WGSL Simulation Engine

This document provides an engineering overview of the WebGPU-accelerated weather physics solver implemented in the Middle-earth Weather Simulator backend.

---

## 🔍 1. Architecture & WGSL Compute Pipelines

To achieve high-performance simulation scaling to $16384 \times 16384$ grids (representing over 268 million cells), the server utilizes **WebGPU Compute Shaders** written in **WGSL** (WebGPU Shading Language) via the Python `wgpu` bindings.

The simulation loop for each time-step ($dt$) is split into two compute shader modules:

### Pass 1: Thermodynamics & Barometric Pressure (`thermo`)
*   **Grid Temperature**: Calculates localized temperature based on latitudinal cooling, altitude-based lapse rate offsets ($28^\circ\text{C}$ cooling per unit elevation), and dynamic solar heating (synced with `time_of_day`).
*   **Atmospheric Pressure**: Models thermal expansion/contraction effects combined with elevation-based pressure drops.

### Pass 2: Wind, Advection & Precipitation (`wind_moist`)
*   **Wind Vectors**: Derived from pressure gradient forces (using central differences) combined with Coriolis deflection and mountain blocking.
*   **Moisture Advection**: Solved using a **Semi-Lagrangian backtrace** scheme.
*   **Precipitation (Rain & Snow)**: Triggered when moisture exceeds temperature-based saturation thresholds, incorporating orographic condensation lift when wind climbs mountain slopes.

### Pass 3: Memory Synchronization
*   Copies the temporary double-buffered moisture array (`moisture_temp`) back to the primary `moisture` storage buffer, establishing the state for the next tick.

---

## 🔄 2. Dynamic Memory Budgeting & CPU Fallback

### Startup VRAM Budget Guard
A single 16k grid containing $16384 \times 16384$ cells consumes **1.07 GB** of VRAM per float32 storage buffer. On dedicated GPU servers, we enforce a **90% VRAM cap** based on the `GPU_VRAM_GB` environment variable (default: `8` GB) to prevent Out-of-Memory (OOM) allocations:
$$\text{Max Allowable Memory} = \text{GPU\_VRAM\_GB} \times 1024^3 \times 0.90$$
If the total required simulation memory exceeds this cap, the server logs a warning and automatically falls back to NumPy CPU mode before allocation.

### Multi-Tier Fallback Strategy
1.  **Driver/Import Fallback**: If the `wgpu` package is not installed or no compatible physical GPU adapters are found on startup, `use_gpu` is flagged `False`.
2.  **WebGPU limit requests**: If the required buffers exceed the default 256MB WebGPU limits, the adapter dynamically requests extended `max_buffer_size` and `max_storage_buffer_binding_size` bounds from the device.
3.  **Runtime Exception Fallback**: The entire command encoder submission in `update_gpu()` is wrapped in a `try...except` block. If any compilation, driver execution, or Out-of-Memory errors trigger at runtime, the simulation seamlessly redirects the current and subsequent ticks to `update_cpu()`.

---

## 🎯 3. Physical Accuracy & Thread-Safety Upgrades

We have implemented several mathematical and structural improvements to the solver:

### A. Directional Mountain Blocking
*   **Problem**: The original model slowed down wind velocities ($vx$, $vy$) near steep slopes regardless of whether the wind was blowing uphill or downhill. Downhill winds were incorrectly blocked.
*   **Solution**: Updated both CPU and GPU shaders to compute directional slope gradients. Wind is now slowed down **only** when it collides with a rising slope (traveling uphill). Downhill wind sweeps naturally over ridges.

### B. RK2 Midpoint Advection
*   **Problem**: First-order Euler backtracing (`prev = x - v * dt`) drifts in high-curvature wind systems.
*   **Solution**: Implemented a **Runge-Kutta 2nd-Order (RK2/Midpoint)** scheme. The backtrace step traces back by a half-timestep ($dt/2$), interpolates the wind velocity at that midpoint, and uses that midpoint velocity to execute the full-step backtrace.

### C. 2D Bicubic Interpolation
*   **Problem**: Bilinear interpolation of moisture introduces high numerical diffusion, causing clouds and moisture boundaries to blur out too quickly.
*   **Solution**: Implemented a $4 \times 4$ stencil **2D Bicubic Interpolation** (cubic Hermite splines) on the target advected field, using boundary-replicated padding to handle edges safely. Clamping prevents overshoot/undershoot issues.

### D. Race-Condition Resolution (`get_wind`)
*   **Problem**: In the single-pass Pass 2 compute shader, writing to `windX[idx]` and concurrently reading `windX[neighbor]` for advection created a Read-After-Write race condition across thread groups, causing CPU-GPU divergence.
*   **Solution**: Created a self-contained, inline `get_wind(col, row)` WGSL helper function. It computes local wind vectors on-the-fly from read-only pressure and height fields, eliminating buffer race conditions entirely and ensuring perfect CPU-GPU matching.

---

## 🧪 4. Testing & Precision Verification

Verification is managed via `pytest` in `server/test_physics.py`.
The consistency test (`test_cpu_gpu_consistency`) runs 5 steps on seeded random terrains for both CPU and GPU:

1.  **Continuous Fields (No Threshold Branching)**:
    `temperature`, `pressure`, and `wind` fields match with extreme precision due to identical arithmetic structures:
    *   **Max Temperature Diff**: $< 10^{-5}$
    *   **Max Pressure Diff**: $< 10^{-4}$
    *   **Max Wind Velocity Diff**: $< 10^{-5}$
    *   *Assertion Threshold*: `atol=1e-4`
2.  **Discontinuous Fields (Threshold Branching)**:
    `moisture` and `precipitation` use hard-threshold conditions (`if moisture > saturation_threshold`). Near boundaries, float32 rounding drifts of $\approx 10^{-7}$ can decide if a cell triggers rain, causing localized moisture consumption step-differences.
    *   *Assertion Strategy*: Asserts that the global grid mean difference remains under `1e-4` (for moisture) and `1e-3` (for rain/snow), while limiting absolute localized max difference bounds.
