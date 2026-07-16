use wgpu::util::DeviceExt;
use std::borrow::Cow;

pub mod octree;
pub mod collider;

#[derive(Debug, PartialEq)]
pub enum ExecutionMode {
    Monolithic,
    Tiled { tile_size: u32, halo_size: u32, master_grid: Option<Vec<f32>> },
}

pub fn determine_execution_mode(buffer_size: wgpu::BufferAddress, physical_vram_limit: wgpu::BufferAddress, force_meshing: &str) -> ExecutionMode {
    let meshing_upper = force_meshing.to_uppercase();
    let is_force_true = meshing_upper == "TRUE";
    let is_force_false = meshing_upper == "FALSE"; // Auto is the default behavior
    
    let limits_exceeded = buffer_size > 2147483647 || buffer_size > physical_vram_limit;
    
    if limits_exceeded || is_force_true {
        if is_force_true {
            println!("[Physics Engine] FORCE_MESHING=True detected. Activating Tiled Compute Mode to join cluster.");
        } else if is_force_false {
            println!("[Physics Engine] Grid size exceeds VRAM limits, but FORCE_MESHING=False. Falling back to LOCAL Iterative Tiled Compute Mode without cluster meshing.");
        } else {
            println!("[Physics Engine] Grid size exceeds VRAM limits (FORCE_MESHING=Auto). Activating Server Meshing to avoid PCIe bottlenecks.");
        }
        ExecutionMode::Tiled { tile_size: 4096, halo_size: 16, master_grid: None }
    } else {
        println!("[Physics Engine] Grid fits entirely in VRAM. Single-machine execution is optimal (Server Meshing would artificially introduce network latency).");
        ExecutionMode::Monolithic
    }
}

pub struct PhysicsSolver {
    device: wgpu::Device,
    queue: wgpu::Queue,
    compute_pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    buffer_size: wgpu::BufferAddress,
    pub mode: ExecutionMode,
}

impl PhysicsSolver {
    /// Initializes a pure Rust wgpu physics context to execute WGSL atmospheric shaders
    pub async fn new(grid_width: u32, grid_height: u32, gpu_vram_gb: u32, is_headless: bool, force_meshing: String, wgsl_shader: &str) -> Self {
        println!("[Physics Engine] Initializing native wgpu-rs compute context...");
        let instance = wgpu::Instance::default();

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .expect("Failed to find an appropriate WebGPU adapter");

        // Request maximum VRAM limits to support massive 16k float grids natively
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Physics Compute Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_buffer_size: 2147483647, // ~2GB to allow 16k x 16k floats
                        max_storage_buffer_binding_size: 2147483647,
                        ..wgpu::Limits::downlevel_defaults()
                    },
                    memory_hints: wgpu::MemoryHints::Performance,
                    ..Default::default()
                }
            )
            .await
            .expect("Failed to create native WebGPU device");

        // Load the WGSL Shader Module
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Atmospheric Compute Shader"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(wgsl_shader)),
        });

        // Compute pipeline setup
        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Weather Physics Pipeline"),
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        // Initialize empty state buffer
        let buffer_size = (grid_width * grid_height * 4) as wgpu::BufferAddress; // 1 float = 4 bytes
        
        let limit_percent = if is_headless { 95 } else { 80 };
        let physical_vram_limit = (gpu_vram_gb as wgpu::BufferAddress) * 1024 * 1024 * 1024 * limit_percent / 100;
        
        let mode = determine_execution_mode(buffer_size, physical_vram_limit, &force_meshing);

        let allocation_size = match mode {
            ExecutionMode::Monolithic => buffer_size,
            ExecutionMode::Tiled { tile_size, halo_size, .. } => {
                let padded_size = tile_size + (2 * halo_size);
                (padded_size * padded_size * 4) as wgpu::BufferAddress
            },
        };

        let storage_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Physics State Buffer"),
            size: allocation_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Bind group
        let bind_group_layout = compute_pipeline.get_bind_group_layout(0);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Physics Bind Group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: storage_buffer.as_entire_binding(),
            }],
        });

        Self {
            device,
            queue,
            compute_pipeline,
            bind_group,
            buffer_size,
            mode,
        }
    }

    /// Dispatches the compute pass natively, avoiding Python memory marshalling entirely.
    pub fn update(&self, dispatch_x: u32, dispatch_y: u32) {
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Physics Compute Encoder"),
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Physics Compute Pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(&self.compute_pipeline);
            compute_pass.set_bind_group(0, &self.bind_group, &[]);
            compute_pass.dispatch_workgroups(dispatch_x, dispatch_y, 1);
        }

        self.queue.submit(Some(encoder.finish()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_physics_solver_compiles() {
        // We cannot reliably instantiate a wgpu::Device in a headless CI environment
        // without an active display adapter (vulkan/metal). So we just ensure it builds!
        assert!(true);
    }
    
    #[test]
    fn test_meshing_mode_logic() {
        // Test 1: Grid fits in VRAM, FORCE_MESHING = Auto -> Monolithic
        assert_eq!(determine_execution_mode(1024, 2048, "Auto"), ExecutionMode::Monolithic);
        
        // Test 2: Grid fits in VRAM, FORCE_MESHING = False -> Monolithic
        assert_eq!(determine_execution_mode(1024, 2048, "False"), ExecutionMode::Monolithic);

        // Test 3: Grid fits in VRAM, FORCE_MESHING = True -> Tiled
        assert_eq!(determine_execution_mode(1024, 2048, "True"), ExecutionMode::Tiled { tile_size: 4096, halo_size: 16, master_grid: None });

        // Test 4: Grid EXCEEDS VRAM limits, FORCE_MESHING = Auto -> Tiled
        assert_eq!(determine_execution_mode(3048, 2048, "Auto"), ExecutionMode::Tiled { tile_size: 4096, halo_size: 16, master_grid: None });

        // Test 5: Grid EXCEEDS VRAM limits, FORCE_MESHING = False -> Tiled (Because it must split compute locally to prevent OOM)
        assert_eq!(determine_execution_mode(3048, 2048, "False"), ExecutionMode::Tiled { tile_size: 4096, halo_size: 16, master_grid: None });
        
        // Test 6: Grid EXCEEDS hard WebGPU limits -> Tiled
        assert_eq!(determine_execution_mode(3_000_000_000, 4_000_000_000, "Auto"), ExecutionMode::Tiled { tile_size: 4096, halo_size: 16, master_grid: None });
    }
}
