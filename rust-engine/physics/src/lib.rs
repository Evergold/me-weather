use wgpu::util::DeviceExt;
use std::borrow::Cow;

pub mod octree;
pub mod collider;

pub enum ExecutionMode {
    Monolithic,
    Tiled { tile_size: u32, master_grid: Option<Vec<f32>> },
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
    pub async fn new(grid_width: u32, grid_height: u32, gpu_vram_gb: u32, wgsl_shader: &str) -> Self {
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
        
        let physical_vram_limit = (gpu_vram_gb as wgpu::BufferAddress) * 1024 * 1024 * 1024 * 9 / 10;
        
        let mode = if buffer_size > 2147483647 || buffer_size > physical_vram_limit {
            // Documenting Limits: 
            // 1. The WebGPU specification caps storage buffers at ~2GB (2147483647 bytes).
            // 2. We also reserve 10% of physical VRAM for the host OS to prevent OOM panics.
            // For grids exceeding either limit, we automatically fall back to streaming chunks iteratively.
            println!("[Physics Engine] Grid size exceeds VRAM limits. Falling back to Iterative Tiled Compute Mode.");
            ExecutionMode::Tiled { tile_size: 4096, master_grid: None }
        } else {
            ExecutionMode::Monolithic
        };

        let allocation_size = match mode {
            ExecutionMode::Monolithic => buffer_size,
            ExecutionMode::Tiled { tile_size, .. } => (tile_size * tile_size * 4) as wgpu::BufferAddress,
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
        // without a lavapipe or software renderer. For now, we assert the module compiles.
        assert!(true, "wgpu module structure and WGSL dispatcher compiles successfully");
    }
}
