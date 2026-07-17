// tessellate.wgsl
// WebGPU Compute Shader for Dynamic Camera-Based Terrain Tessellation

@group(0) @binding(0) var<uniform> camera: vec4<f32>; // xyz = pos, w = lodRadius
@group(0) @binding(1) var<storage, read> sourcePositions: array<f32>;
@group(0) @binding(2) var<storage, read_write> targetPositions: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    
    // Bounds check (index is per-vertex, array is flat floats so multiply by 3)
    if (index * 3 >= arrayLength(&sourcePositions)) {
        return;
    }
    
    let x = sourcePositions[index * 3];
    let y = sourcePositions[index * 3 + 1];
    let z = sourcePositions[index * 3 + 2];
    
    let pos = vec3<f32>(x, y, z);
    let camPos = camera.xyz;
    let dist = distance(pos, camPos);
    
    var outX = x;
    var outZ = z;
    
    // --- NANITE-STYLE DYNAMIC TESSELLATION LOD ---
    // If the vertex is far away, we mathematically snap it into its neighbor's position.
    // When the GPU rasterizer sees a triangle with snapped (degenerate/identical) vertices, 
    // it automatically culls the zero-area triangle at zero cost! This acts as a highly 
    // efficient mesh decimation system entirely on the GPU.
    if (dist > camera.w) {
        let snapSize = dist * 0.0025; 
        outX = round(x / snapSize) * snapSize;
        outZ = round(z / snapSize) * snapSize;
    }
    
    targetPositions[index * 3] = outX;
    targetPositions[index * 3 + 1] = y;
    targetPositions[index * 3 + 2] = outZ;
}
