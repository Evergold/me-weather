// Client-Side WebGPU Compute Shader for Frustum Culling
//
// This shader takes the 6 frustum planes of the camera and an array of
// Tile Bounding Boxes (AABBs). It computes intersections in parallel
// and outputs an array of active Tile IDs to be rendered.

struct Plane {
    normal: vec3<f32>,
    distance: f32,
}

struct Frustum {
    planes: array<Plane, 6>,
    tileCount: u32,
    padding1: u32,
    padding2: u32,
    padding3: u32,
}

struct AABB {
    min: vec3<f32>,
    max: vec3<f32>,
}

struct TileData {
    aabb: AABB,
    id: u32,
}

@group(0) @binding(0) var<uniform> frustum: Frustum;
@group(0) @binding(1) var<storage, read> tiles: array<TileData>;
@group(0) @binding(2) var<storage, read_write> visible_tiles: array<u32>;
@group(0) @binding(3) var<storage, read_write> visible_count: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    
    // Bounds check
    if (index >= frustum.tileCount) {
        return;
    }

    let tile = tiles[index];
    let bmin = tile.aabb.min;
    let bmax = tile.aabb.max;

    var is_visible = true;

    // Check intersection against all 6 frustum planes
    for (var i = 0u; i < 6u; i = i + 1u) {
        let p = frustum.planes[i];
        
        // Find the p-vertex (the vertex of the AABB furthest in the direction of the plane normal)
        var p_vertex = vec3<f32>(
            select(bmin.x, bmax.x, p.normal.x >= 0.0),
            select(bmin.y, bmax.y, p.normal.y >= 0.0),
            select(bmin.z, bmax.z, p.normal.z >= 0.0)
        );

        // If the p-vertex is on the negative side of the plane, the AABB is completely outside
        if (dot(p.normal, p_vertex) + p.distance < 0.0) {
            is_visible = false;
            break;
        }
    }

    if (is_visible) {
        // Atomically increment the visible count and store the tile ID
        let write_idx = atomicAdd(&visible_count, 1u);
        visible_tiles[write_idx] = tile.id;
    }
}
