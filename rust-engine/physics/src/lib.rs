use wgpu::util::DeviceExt;
use std::borrow::Cow;

pub struct PhysicsSolver {
    device: wgpu::Device,
    queue: wgpu::Queue,
    compute_pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    buffer_size: wgpu::BufferAddress,
}

impl PhysicsSolver {
    /// Initializes a pure Rust wgpu physics context to execute WGSL atmospheric shaders
    pub async fn new(grid_width: u32, grid_height: u32, wgsl_shader: &str) -> Self {
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
                    required_limits: wgpu::Limits::downlevel_defaults(), // Can request max here
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
        let storage_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Physics State Buffer"),
            size: buffer_size,
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
