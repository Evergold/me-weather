# physics_solver.py (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
# Licensed under the MIT License (see LICENSE for details)

import os
import math
import numpy as np
from PIL import Image

# Attempt to import wgpu for GPU compute
try:
    import wgpu
    HAS_WGPU = True
except ImportError:
    HAS_WGPU = False

class WeatherPhysics:
    def __init__(self, width=8192, height=8192, use_gpu=True):
        self.width = width
        self.height = height
        self.size = width * height
        self.use_gpu = use_gpu and HAS_WGPU
        
        # CPU master grids (flat numpy arrays)
        self.heightmap = np.zeros(self.size, dtype=np.float32)
        self.temperature = np.zeros(self.size, dtype=np.float32)
        self.pressure = np.zeros(self.size, dtype=np.float32)
        self.moisture = np.zeros(self.size, dtype=np.float32)
        self.windX = np.zeros(self.size, dtype=np.float32)
        self.windY = np.zeros(self.size, dtype=np.float32)
        self.rain = np.zeros(self.size, dtype=np.float32)
        self.snow = np.zeros(self.size, dtype=np.float32)
        self.is_water = np.zeros(self.size, dtype=np.uint32)

        # Pre-allocated arrays to optimize memory allocation and performance during CPU updates
        self.lat_grid = np.repeat((np.arange(self.height, dtype=np.float32) / self.height) * 20.0 - 8.0, self.width)
        self.coriolis_factor = (0.08 * (1.0 - np.arange(self.height, dtype=np.float32) / self.height)).reshape((self.height, 1))
        # Pre-compute mesh grids for advection
        grid_y, grid_x = np.mgrid[0:self.height, 0:self.width]
        self.grid_x = grid_x.astype(np.float32)
        self.grid_y = grid_y.astype(np.float32)

        # WebGPU Device and Buffers
        self.device = None
        self.gpu_buffers = {}
        if self.use_gpu:
            self.init_gpu()

    def init_gpu(self):
        try:
            # 1. Enforce GPU_VRAM_GB check (Feature requirement from migration plan)
            vram_hint_gb = float(os.getenv("GPU_VRAM_GB", "8"))
            vram_limit_bytes = int(vram_hint_gb * 1024 * 1024 * 1024)
            required_bytes = self.size * 33
            max_allowable_memory = int(vram_limit_bytes * 0.90)
            
            if required_bytes > max_allowable_memory:
                print(f"[Physics] WARNING: Requested WebGPU buffers ({required_bytes / (1024*1024):.1f} MB) exceed 90% of the GPU_VRAM_GB limit ({max_allowable_memory / (1024*1024):.1f} MB).")
                print("[Physics] Automatically falling back to CPU NumPy mode to prevent OutOfMemory crashes.")
                self.use_gpu = False
                return

            # Request WebGPU adapter and device
            adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
            if adapter is None:
                print("[Physics] No suitable GPU adapter found. Falling back to CPU.")
                self.use_gpu = False
                return

            # Configure required limits based on allocation sizes
            required_limits = {}
            if required_bytes > 256 * 1024 * 1024:
                required_limits["max_buffer_size"] = min(2048 * 1024 * 1024, required_bytes)
                required_limits["max_storage_buffer_binding_size"] = min(2048 * 1024 * 1024, required_bytes)

            self.device = adapter.request_device_sync(required_limits=required_limits)
            print("[Physics] WebGPU Initialized successfully.")
            self.setup_gpu_buffers()
        except Exception as e:
            print(f"[Physics] Failed to initialize WebGPU: {e}. Falling back to CPU.")
            self.use_gpu = False

    def setup_gpu_buffers(self):
        # Create WebGPU buffers for simulation fields
        buffer_sizes = {
            "heightmap": self.size * 4,
            "temperature": self.size * 4,
            "pressure": self.size * 4,
            "moisture": self.size * 4,
            "windX": self.size * 4,
            "windY": self.size * 4,
            "rain": self.size * 4,
            "snow": self.size * 4,
            "is_water": self.size * 4,
        }
        for name, size in buffer_sizes.items():
            self.gpu_buffers[name] = self.device.create_buffer(
                size=size,
                usage=wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_DST | wgpu.BufferUsage.COPY_SRC
            )
        self.setup_gpu_pipelines()

    def setup_gpu_pipelines(self):
        # Create uniform params buffer (32 bytes)
        self.gpu_buffers["params"] = self.device.create_buffer(
            size=32,
            usage=wgpu.BufferUsage.UNIFORM | wgpu.BufferUsage.COPY_DST
        )
        
        # Create moisture_temp buffer
        self.gpu_buffers["moisture_temp"] = self.device.create_buffer(
            size=self.size * 4,
            usage=wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_DST | wgpu.BufferUsage.COPY_SRC
        )
        
        # WGSL Shader 1 (Thermodynamics and Pressure)
        shader1_code = """
        struct SimParams {
            width: u32,
            height: u32,
            dt: f32,
            solar_intensity: f32,
            season_base_temp: f32,
            global_wind_vx: f32,
            global_wind_vy: f32,
            decouple_hydrology: u32,
        };

        @group(0) @binding(0) var<uniform> params: SimParams;
        @group(0) @binding(1) var<storage, read> heightmap: array<f32>;
        @group(0) @binding(2) var<storage, read_write> temperature: array<f32>;
        @group(0) @binding(3) var<storage, read_write> pressure: array<f32>;

        @compute @workgroup_size(16, 16)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let col = id.x;
            let row = id.y;
            if (col >= params.width || row >= params.height) {
                return;
            }
            let idx = row * params.width + col;
            
            let lat = (f32(row) / f32(params.height)) * 20.0 - 8.0;
            let h = heightmap[idx];
            let lapse_rate = h * 28.0;
            let solar_warming = params.solar_intensity * (15.0 - h * 5.0);
            
            let temp = params.season_base_temp + lat - lapse_rate + solar_warming;
            temperature[idx] = temp;
            
            let elevation_pressure_drop = h * 120.0;
            let thermal_pressure_shift = (temp - 15.0) * -1.5;
            pressure[idx] = 1013.0 - elevation_pressure_drop + thermal_pressure_shift;
        }
        """
        
        # WGSL Shader 2 (Wind, Evaporation, Advection, Precipitation)
        shader2_code = """
        struct SimParams {
            width: u32,
            height: u32,
            dt: f32,
            solar_intensity: f32,
            season_base_temp: f32,
            global_wind_vx: f32,
            global_wind_vy: f32,
            decouple_hydrology: u32,
        };

        @group(0) @binding(0) var<uniform> params: SimParams;
        @group(0) @binding(1) var<storage, read> heightmap: array<f32>;
        @group(0) @binding(2) var<storage, read> temperature: array<f32>;
        @group(0) @binding(3) var<storage, read> pressure: array<f32>;
        @group(0) @binding(4) var<storage, read_write> moisture: array<f32>;
        @group(0) @binding(5) var<storage, read_write> windX: array<f32>;
        @group(0) @binding(6) var<storage, read_write> windY: array<f32>;
        @group(0) @binding(7) var<storage, read_write> rain: array<f32>;
        @group(0) @binding(8) var<storage, read_write> snow: array<f32>;
        @group(0) @binding(9) var<storage, read> is_water: array<u32>;
        @group(0) @binding(10) var<storage, read_write> moisture_temp: array<f32>;

        @compute @workgroup_size(16, 16)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            let col = id.x;
            let row = id.y;
            let w = params.width;
            let h = params.height;
            
            if (col >= w || row >= h) {
                return;
            }
            let idx = row * w + col;
            
            // 1. Wind fields gradient
            var dpdx = 0.0;
            var dpdy = 0.0;
            
            if (col > 0u && col < w - 1u) {
                dpdx = (pressure[idx + 1u] - pressure[idx - 1u]) / 2.0;
            }
            
            if (row > 0u && row < h - 1u) {
                dpdy = (pressure[idx + w] - pressure[idx - w]) / 2.0;
            }
            
            var vx = -dpdx * 0.15;
            var vy = -dpdy * 0.15;
            
            let coriolis = 0.08 * (1.0 - f32(row) / f32(h));
            let cor_x = vy * coriolis;
            let cor_y = -vx * coriolis;
            vx += cor_x;
            vy += cor_y;
            
            vx += params.global_wind_vx;
            vy += params.global_wind_vy;
            
            // Mountain Blocking
            var grad_x = 0.0;
            var grad_y = 0.0;
            
            if (col > 0u) {
                grad_x = heightmap[idx] - heightmap[idx - 1u];
            }
            if (row > 0u) {
                grad_y = heightmap[idx] - heightmap[idx - w];
            }
            
            if (grad_x > 0.0) {
                vx = vx * max(0.05, 1.0 - grad_x * 8.0);
            }
            if (grad_y > 0.0) {
                vy = vy * max(0.05, 1.0 - grad_y * 8.0);
            }
            
            windX[idx] = vx;
            windY[idx] = vy;
            
            // 2. Moisture Evaporation
            let local_water = is_water[idx];
            let temp_evap = max(0.01, (temperature[idx] + 10.0) * 0.015) * params.dt;
            
            // 3. Advection (Semi-Lagrangian)
            let prev_x = f32(col) - vx * params.dt * 15.0;
            let prev_y = f32(row) - vy * params.dt * 15.0;
            
            let px = clamp(prev_x, 0.5, f32(w) - 1.5);
            let py = clamp(prev_y, 0.5, f32(h) - 1.5);
            
            let x0 = u32(floor(px));
            let x1 = x0 + 1u;
            let y0 = u32(floor(py));
            let y1 = y0 + 1u;
            
            let fx = px - f32(x0);
            let fy = py - f32(y0);
            
            let val00 = moisture[y0 * w + x0];
            let val10 = moisture[y0 * w + x1];
            let val01 = moisture[y1 * w + x0];
            let val11 = moisture[y1 * w + x1];
            
            let val0 = val00 * (1.0 - fx) + val10 * fx;
            let val1 = val01 * (1.0 - fx) + val11 * fx;
            let advected_moist = val0 * (1.0 - fy) + val1 * fy;
            
            var final_moist = advected_moist;
            if (local_water == 1u) {
                final_moist = min(1.0, final_moist + temp_evap);
            }
            
            // 4. Precipitation
            var rain_val = 0.0;
            var snow_val = 0.0;
            
            if (params.decouple_hydrology == 0u) {
                let saturation_threshold = max(0.35, 0.6 + (temperature[idx] - 10.0) * 0.015);
                if (final_moist > saturation_threshold) {
                    let excess = final_moist - saturation_threshold;
                    
                    let next_col = min(w - 1u, col + 1u);
                    let next_row = min(h - 1u, row + 1u);
                    let h_diff_x = heightmap[row * w + next_col] - heightmap[idx];
                    let h_diff_y = heightmap[next_row * w + col] - heightmap[idx];
                    
                    let lift = max(0.0, vx * h_diff_x + vy * h_diff_y) * 1.5;
                    
                    var precip_rate = excess * 0.4 + lift * final_moist * 0.5;
                    precip_rate = min(1.0, precip_rate * params.dt * 5.0);
                    
                    if (temperature[idx] < 0.5) {
                        snow_val = precip_rate;
                    } else {
                        rain_val = precip_rate;
                    }
                    
                    final_moist = max(0.05, final_moist - precip_rate * 0.8);
                }
                
                if (local_water == 0u && rain_val + snow_val <= 0.01) {
                    final_moist = max(0.1, final_moist - 0.015 * params.dt);
                }
            }
            
            rain[idx] = rain_val;
            snow[idx] = snow_val;
            moisture_temp[idx] = final_moist;
        }
        """
        
        # Compile modules
        sm1 = self.device.create_shader_module(code=shader1_code)
        sm2 = self.device.create_shader_module(code=shader2_code)
        
        # Create pipelines
        self.gpu_pipelines = {
            "thermo": self.device.create_compute_pipeline(
                layout="auto",
                compute={"module": sm1, "entry_point": "main"}
            ),
            "wind_moist": self.device.create_compute_pipeline(
                layout="auto",
                compute={"module": sm2, "entry_point": "main"}
            )
        }
        
        # Bind group entries
        bg1_entries = [
            {"binding": 0, "resource": {"buffer": self.gpu_buffers["params"], "offset": 0, "size": 32}},
            {"binding": 1, "resource": {"buffer": self.gpu_buffers["heightmap"], "offset": 0, "size": self.size * 4}},
            {"binding": 2, "resource": {"buffer": self.gpu_buffers["temperature"], "offset": 0, "size": self.size * 4}},
            {"binding": 3, "resource": {"buffer": self.gpu_buffers["pressure"], "offset": 0, "size": self.size * 4}}
        ]
        
        self.gpu_bind_groups = {
            "thermo": self.device.create_bind_group(
                layout=self.gpu_pipelines["thermo"].get_bind_group_layout(0),
                entries=bg1_entries
            )
        }
        
        bg2_entries = [
            {"binding": 0, "resource": {"buffer": self.gpu_buffers["params"], "offset": 0, "size": 32}},
            {"binding": 1, "resource": {"buffer": self.gpu_buffers["heightmap"], "offset": 0, "size": self.size * 4}},
            {"binding": 2, "resource": {"buffer": self.gpu_buffers["temperature"], "offset": 0, "size": self.size * 4}},
            {"binding": 3, "resource": {"buffer": self.gpu_buffers["pressure"], "offset": 0, "size": self.size * 4}},
            {"binding": 4, "resource": {"buffer": self.gpu_buffers["moisture"], "offset": 0, "size": self.size * 4}},
            {"binding": 5, "resource": {"buffer": self.gpu_buffers["windX"], "offset": 0, "size": self.size * 4}},
            {"binding": 6, "resource": {"buffer": self.gpu_buffers["windY"], "offset": 0, "size": self.size * 4}},
            {"binding": 7, "resource": {"buffer": self.gpu_buffers["rain"], "offset": 0, "size": self.size * 4}},
            {"binding": 8, "resource": {"buffer": self.gpu_buffers["snow"], "offset": 0, "size": self.size * 4}},
            {"binding": 9, "resource": {"buffer": self.gpu_buffers["is_water"], "offset": 0, "size": self.size * 4}},
            {"binding": 10, "resource": {"buffer": self.gpu_buffers["moisture_temp"], "offset": 0, "size": self.size * 4}}
        ]
        
        self.gpu_bind_groups["wind_moist"] = self.device.create_bind_group(
            layout=self.gpu_pipelines["wind_moist"].get_bind_group_layout(0),
            entries=bg2_entries
        )

    def load_heightmap(self, img_path):
        """Loads a heightmap image and initializes physical fields."""
        if not os.path.exists(img_path):
            # Create a dummy heightmap if none exists
            print(f"[Physics] Heightmap not found at {img_path}. Creating flat terrain.")
            img = Image.new('L', (self.width, self.height), color=25)  # 25/255 height
            os.makedirs(os.path.dirname(img_path), exist_ok=True)
            img.save(img_path)

        img = Image.open(img_path).convert('L').resize((self.width, self.height))
        raw_data = np.array(img, dtype=np.float32) / 255.0
        self.heightmap = raw_data.flatten()

        # Ocean is defined as height < 0.08
        self.is_water = (self.heightmap < 0.08).astype(np.uint32)

        # Initial conditions
        self.moisture = np.where(self.is_water == 1, 0.9, 0.4).astype(np.float32)
        self.temperature.fill(15.0)
        self.pressure.fill(1013.0)
        self.windX.fill(0.0)
        self.windY.fill(0.0)
        self.rain.fill(0.0)
        self.snow.fill(0.0)

        # Upload initial data to GPU if enabled
        if self.use_gpu:
            self.device.queue.write_buffer(self.gpu_buffers["heightmap"], 0, self.heightmap)
            self.device.queue.write_buffer(self.gpu_buffers["is_water"], 0, self.is_water)
            self.device.queue.write_buffer(self.gpu_buffers["moisture"], 0, self.moisture)
            self.device.queue.write_buffer(self.gpu_buffers["temperature"], 0, self.temperature)
            self.device.queue.write_buffer(self.gpu_buffers["pressure"], 0, self.pressure)
            self.device.queue.write_buffer(self.gpu_buffers["windX"], 0, self.windX)
            self.device.queue.write_buffer(self.gpu_buffers["windY"], 0, self.windY)

    def update(self, dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology=False):
        """Orchestrates a single simulation update loop."""
        if self.use_gpu:
            self.update_gpu(dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology)
        else:
            self.update_cpu(dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology)

    def get_solar_intensity(self, time_of_day):
        hour = time_of_day / 60.0
        day_factor = math.sin((hour - 6.0) * math.pi / 12.0)
        return max(0.0, day_factor)

    def get_season_base_temp(self, season):
        temps = {'spring': 12.0, 'summer': 25.0, 'autumn': 8.0, 'winter': -5.0}
        return temps.get(season, 12.0)

    def update_cpu(self, dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology):
        """Vectorized NumPy implementation of the simulation grid update."""
        solar_intensity = self.get_solar_intensity(time_of_day)
        season_base_temp = self.get_season_base_temp(season) + global_temp_shift

        rad = (global_wind_angle * math.pi) / 180.0
        global_wind_vx = math.sin(rad) * (global_wind_speed * 0.08)
        global_wind_vy = -math.cos(rad) * (global_wind_speed * 0.08)

        # 1. Thermodynamics & Pressure
        lapse_rate = self.heightmap * 28.0
        solar_warming = solar_intensity * (15.0 - self.heightmap * 5.0)
        
        self.temperature = season_base_temp + self.lat_grid - lapse_rate + solar_warming
        
        elevation_pressure_drop = self.heightmap * 120.0
        thermal_pressure_shift = (self.temperature - 15.0) * -1.5
        self.pressure = 1013.0 - elevation_pressure_drop + thermal_pressure_shift

        # 2. Wind Fields (Pressure Gradient Force + Coriolis + Mountain Blocking)
        # Reshape to 2D for stencil operations
        p = self.pressure.reshape((self.height, self.width))
        h = self.heightmap.reshape((self.height, self.width))
        
        # Calculate gradients
        dpdx = np.zeros_like(p)
        dpdy = np.zeros_like(p)
        dpdx[:, 1:-1] = (p[:, 2:] - p[:, :-2]) / 2.0
        dpdy[1:-1, :] = (p[2:, :] - p[:-2, :]) / 2.0

        vx = -dpdx * 0.15
        vy = -dpdy * 0.15

        # Coriolis factor
        cor_x = vy * self.coriolis_factor
        cor_y = -vx * self.coriolis_factor
        vx += cor_x
        vy += cor_y

        # Global atmospheric steering
        vx += global_wind_vx
        vy += global_wind_vy

        # Mountain Blocking
        grad_x = np.zeros_like(vx)
        grad_y = np.zeros_like(vy)
        
        # Climbing slope checks
        grad_x[:, 1:] = np.where(vx[:, 1:] > 0, h[:, 1:] - h[:, :-1], h[:, 1:] - h[:, :-1]) # Simplification
        grad_y[1:, :] = np.where(vy[1:, :] > 0, h[1:, :] - h[:-1, :], h[1:, :] - h[:-1, :])

        vx = np.where(grad_x > 0, vx * np.maximum(0.05, 1.0 - grad_x * 8.0), vx)
        vy = np.where(grad_y > 0, vy * np.maximum(0.05, 1.0 - grad_y * 8.0), vy)

        self.windX = vx.flatten()
        self.windY = vy.flatten()

        # 3. Advection (Semi-Lagrangian) - performed before evaporation to match GPU pipeline
        self.advect_cpu(self.moisture, self.windX, self.windY, dt)

        # 4. Moisture Evaporation - performed on advected moisture to match GPU pipeline
        temp_evap = np.maximum(0.01, (self.temperature + 10.0) * 0.015) * dt
        self.moisture = np.where(self.is_water == 1, np.minimum(1.0, self.moisture + temp_evap), self.moisture)

        # 5. Precipitation (Dynamic Hydrology)
        if not decouple_hydrology:
            saturation_threshold = np.maximum(0.35, 0.6 + (self.temperature - 10.0) * 0.015)
            excess = self.moisture - saturation_threshold
            
            # Boundary-clamped elevation gradient for Orographic Condensation (matches GPU)
            h_diff_x = np.zeros_like(h)
            h_diff_y = np.zeros_like(h)
            h_diff_x[:, :-1] = h[:, 1:] - h[:, :-1]
            h_diff_y[:-1, :] = h[1:, :] - h[:-1, :]
            
            lift = np.maximum(0.0, self.windX * h_diff_x.flatten() + self.windY * h_diff_y.flatten()) * 1.5

            precip_rate = np.zeros_like(self.moisture)
            cond_mask = self.moisture > saturation_threshold
            precip_rate[cond_mask] = excess[cond_mask] * 0.4 + lift[cond_mask] * self.moisture[cond_mask] * 0.5
            
            precip_rate = np.minimum(1.0, precip_rate * dt * 5.0)

            # Assign rain/snow
            cold_mask = self.temperature < 0.5
            self.snow = np.where(cold_mask, precip_rate, 0.0)
            self.rain = np.where(~cold_mask, precip_rate, 0.0)

            # Consume moisture due to rainout
            self.moisture = np.maximum(0.05, self.moisture - precip_rate * 0.8)

            # Land dry recovery
            dry_mask = (self.is_water == 0) & (precip_rate <= 0.01)
            self.moisture[dry_mask] = np.maximum(0.1, self.moisture[dry_mask] - 0.015 * dt)

    def advect_cpu(self, field, vx, vy, dt):
        """Semi-Lagrangian backtrace interpolation using NumPy."""
        w, h = self.width, self.height
        y, x = self.grid_y, self.grid_x
        
        # Trace backwards
        prev_x = x - vx.reshape((h, w)) * dt * 15.0
        prev_y = y - vy.reshape((h, w)) * dt * 15.0

        # Clamp boundaries
        prev_x = np.clip(prev_x, 0.5, w - 1.5)
        prev_y = np.clip(prev_y, 0.5, h - 1.5)

        # Bilinear interpolation elements
        x0 = np.floor(prev_x).astype(np.int32)
        x1 = x0 + 1
        y0 = np.floor(prev_y).astype(np.int32)
        y1 = y0 + 1

        fx = prev_x - x0
        fy = prev_y - y0

        field_2d = field.reshape((h, w))

        val00 = field_2d[y0, x0]
        val10 = field_2d[y0, x1]
        val01 = field_2d[y1, x0]
        val11 = field_2d[y1, x1]

        val0 = val00 * (1 - fx) + val10 * fx
        val1 = val01 * (1 - fx) + val11 * fx
        
        field[:] = (val0 * (1 - fy) + val1 * fy).flatten()

    def update_gpu(self, dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology):
        """GPU-accelerated physics tick using WGSL Compute Shaders."""
        try:
            solar_intensity = self.get_solar_intensity(time_of_day)
            season_base_temp = self.get_season_base_temp(season) + global_temp_shift

            rad = (global_wind_angle * math.pi) / 180.0
            global_wind_vx = math.sin(rad) * (global_wind_speed * 0.08)
            global_wind_vy = -math.cos(rad) * (global_wind_speed * 0.08)

            # 1. Update uniforms (params) buffer
            import struct
            params_bytes = struct.pack(
                "IIfffffI",
                self.width,
                self.height,
                dt,
                solar_intensity,
                season_base_temp,
                global_wind_vx,
                global_wind_vy,
                1 if decouple_hydrology else 0
            )
            self.device.queue.write_buffer(self.gpu_buffers["params"], 0, params_bytes)

            # 2. Build and submit command encoder
            encoder = self.device.create_command_encoder()
            
            # Pass 1: Thermo and Pressure
            compute_pass1 = encoder.begin_compute_pass()
            compute_pass1.set_pipeline(self.gpu_pipelines["thermo"])
            compute_pass1.set_bind_group(0, self.gpu_bind_groups["thermo"])
            compute_pass1.dispatch_workgroups(math.ceil(self.width / 16), math.ceil(self.height / 16), 1)
            compute_pass1.end()

            # Pass 2: Wind, Evap, Advect, Precip
            compute_pass2 = encoder.begin_compute_pass()
            compute_pass2.set_pipeline(self.gpu_pipelines["wind_moist"])
            compute_pass2.set_bind_group(0, self.gpu_bind_groups["wind_moist"])
            compute_pass2.dispatch_workgroups(math.ceil(self.width / 16), math.ceil(self.height / 16), 1)
            compute_pass2.end()

            # Pass 3: Copy moisture_temp back to moisture
            encoder.copy_buffer_to_buffer(
                self.gpu_buffers["moisture_temp"], 0,
                self.gpu_buffers["moisture"], 0,
                self.size * 4
            )

            # Submit to device queue
            self.device.queue.submit([encoder.finish()])

            # 3. Read back updated fields to CPU arrays to keep queries & telemetry synced
            self.temperature = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["temperature"]), dtype=np.float32).copy()
            self.pressure = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["pressure"]), dtype=np.float32).copy()
            self.windX = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["windX"]), dtype=np.float32).copy()
            self.windY = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["windY"]), dtype=np.float32).copy()
            self.moisture = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["moisture"]), dtype=np.float32).copy()
            self.rain = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["rain"]), dtype=np.float32).copy()
            self.snow = np.frombuffer(self.device.queue.read_buffer(self.gpu_buffers["snow"]), dtype=np.float32).copy()
        except Exception as e:
            # Fallback to CPU update if any WebGPU pipeline/compilation errors occur
            print(f"[Physics] GPU Simulation error: {e}. Falling back to CPU update.")
            self.update_cpu(dt, time_of_day, season, global_wind_speed, global_wind_angle, global_temp_shift, decouple_hydrology)

    def get_weather_at(self, x, y):
        """Bilinear interpolation lookup of weather stats for a normalized coordinate (x,y in [0,1])."""
        px = max(0.0, min(self.width - 1.0, x * (self.width - 1)))
        py = max(0.0, min(self.height - 1.0, y * (self.height - 1)))

        x0 = int(px)
        x1 = min(self.width - 1, x0 + 1)
        y0 = int(py)
        y1 = min(self.height - 1, y0 + 1)

        fx = px - x0
        fy = py - y0

        def lookup(field):
            v00 = field[y0 * self.width + x0]
            v10 = field[y0 * self.width + x1]
            v01 = field[y1 * self.width + x0]
            v11 = field[y1 * self.width + x1]
            v0 = v00 * (1.0 - fx) + v10 * fx
            v1 = v01 * (1.0 - fx) + v11 * fx
            return v0 * (1.0 - fy) + v1 * fy

        alt_val = lookup(self.heightmap)
        temp_val = lookup(self.temperature)
        moisture_val = lookup(self.moisture)
        press_val = lookup(self.pressure)
        wx_val = lookup(self.windX)
        wy_val = lookup(self.windY)
        rain_val = lookup(self.rain)
        snow_val = lookup(self.snow)

        # Condition String
        condition = 'Clear'
        if rain_val > 0.05:
            condition = 'Heavy Rain' if rain_val > 0.3 else 'Light Rain'
        elif snow_val > 0.05:
            condition = 'Heavy Snow (Blizzard)' if snow_val > 0.3 else 'Light Snow'
        elif moisture_val > 0.75:
            condition = 'Foggy/Overcast'
        elif moisture_val > 0.55:
            condition = 'Partly Cloudy'

        return {
            'altitude': int(alt_val * 3800),
            'temperature': round(float(temp_val), 1),
            'moisture': int(moisture_val * 100),
            'pressure': int(press_val),
            'windSpeed': int(math.sqrt(wx_val*wx_val + wy_val*wy_val) / 0.08),
            'windAngle': int((math.atan2(wx_val, -wy_val) * 180.0 / math.pi) % 360),
            'rain': int(rain_val * 100),
            'snow': int(snow_val * 100),
            'condition': condition
        }

    def get_serialized_grid(self, downsample_factor=8):
        """Downsamples and packages active weather layers into a flat binary array (Normalized Integer Mapping)."""
        ds_w = self.width // downsample_factor
        ds_h = self.height // downsample_factor

        # Reshape active fields for slicing
        temp_2d = self.temperature.reshape((self.height, self.width))
        moist_2d = self.moisture.reshape((self.height, self.width))
        wx_2d = self.windX.reshape((self.height, self.width))
        wy_2d = self.windY.reshape((self.height, self.width))
        rain_2d = self.rain.reshape((self.height, self.width))
        snow_2d = self.snow.reshape((self.height, self.width))

        # Downsample using simple striding
        ds_temp = temp_2d[::downsample_factor, ::downsample_factor]
        ds_moist = moist_2d[::downsample_factor, ::downsample_factor]
        ds_wx = wx_2d[::downsample_factor, ::downsample_factor]
        ds_wy = wy_2d[::downsample_factor, ::downsample_factor]
        ds_rain = rain_2d[::downsample_factor, ::downsample_factor]
        ds_snow = snow_2d[::downsample_factor, ::downsample_factor]

        # Quantize layers: temp [-20, 50] to uint16, wind [-60, 60] to uint16, others [0, 1] to uint8
        temp_q = np.clip((ds_temp + 20.0) / 70.0 * 65535.0, 0, 65535).astype(np.uint16)
        moist_q = np.clip(ds_moist * 255.0, 0, 255).astype(np.uint8)
        wx_q = np.clip((ds_wx + 60.0) / 120.0 * 65535.0, 0, 65535).astype(np.uint16)
        wy_q = np.clip((ds_wy + 60.0) / 120.0 * 65535.0, 0, 65535).astype(np.uint16)
        rain_q = np.clip(ds_rain * 255.0, 0, 255).astype(np.uint8)
        snow_q = np.clip(ds_snow * 255.0, 0, 255).astype(np.uint8)

        # Concatenate bytes: ordered [temp, moist, windX, windY, rain, snow]
        return (temp_q.tobytes() + moist_q.tobytes() + wx_q.tobytes() + 
                wy_q.tobytes() + rain_q.tobytes() + snow_q.tobytes())

    def get_serialized_chunk(self, x_start, y_start, chunk_size=1024):
        """Extracts a high-resolution chunk of weather statistics for zoomed-in rendering."""
        x_end = min(self.width, x_start + chunk_size)
        y_end = min(self.height, y_start + chunk_size)

        temp_2d = self.temperature.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]
        moist_2d = self.moisture.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]
        wx_2d = self.windX.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]
        wy_2d = self.windY.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]
        rain_2d = self.rain.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]
        snow_2d = self.snow.reshape((self.height, self.width))[y_start:y_end, x_start:x_end]

        # Pad if chunk is at boundaries
        h_chunk, w_chunk = temp_2d.shape
        if h_chunk < chunk_size or w_chunk < chunk_size:
            temp_2d = np.pad(temp_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')
            moist_2d = np.pad(moist_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')
            wx_2d = np.pad(wx_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')
            wy_2d = np.pad(wy_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')
            rain_2d = np.pad(rain_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')
            snow_2d = np.pad(snow_2d, ((0, chunk_size - h_chunk), (0, chunk_size - w_chunk)), mode='edge')

        # Quantize layers
        temp_q = np.clip((temp_2d + 20.0) / 70.0 * 65535.0, 0, 65535).astype(np.uint16)
        moist_q = np.clip(moist_2d * 255.0, 0, 255).astype(np.uint8)
        wx_q = np.clip((wx_2d + 60.0) / 120.0 * 65535.0, 0, 65535).astype(np.uint16)
        wy_q = np.clip((wy_2d + 60.0) / 120.0 * 65535.0, 0, 65535).astype(np.uint16)
        rain_q = np.clip(rain_2d * 255.0, 0, 255).astype(np.uint8)
        snow_q = np.clip(snow_2d * 255.0, 0, 255).astype(np.uint8)

        return (temp_q.tobytes() + moist_q.tobytes() + wx_q.tobytes() + 
                wy_q.tobytes() + rain_q.tobytes() + snow_q.tobytes())
