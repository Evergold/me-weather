use crate::octree::{OctreeNode, Vec3, Collidable, AABB};
use image::{GenericImageView, DynamicImage};
use std::path::Path;

pub struct WorldCollider {
    pub heightmap: Vec<Vec<f32>>,
    pub octree: OctreeNode,
    
    pub grid_width: f32,
    pub grid_depth: f32,
    pub max_height: f32,
}

impl WorldCollider {
    /// Initializes the collision world by loading the 2D heightmap for instant O(1) terrain validation
    /// and a 3D Octree for objects, buildings, and players.
    pub fn new(heightmap_path: &str, grid_width: f32, grid_depth: f32, max_height: f32) -> Self {
        println!("[Physics] Initializing WorldCollider. Parsing heightmap: {}", heightmap_path);
        
        // 1. Parse Heightmap into 2D Array
        let mut heightmap_data = Vec::new();
        
        let img = image::open(&Path::new(heightmap_path)).unwrap_or_else(|_| {
            println!("[Physics] WARNING: Heightmap not found. Falling back to flat plane.");
            DynamicImage::new_luma8(1024, 1024)
        });
        
        let (width, height) = img.dimensions();
        let luma = img.to_luma8();
        
        for y in 0..height {
            let mut row = Vec::with_capacity(width as usize);
            for x in 0..width {
                let pixel = luma.get_pixel(x, y)[0];
                let normalized_height = (pixel as f32 / 255.0) * max_height;
                row.push(normalized_height);
            }
            heightmap_data.push(row);
        }

        // 2. Initialize Octree root node
        // Span the whole world. Min is usually (-width/2, 0, -depth/2) and Max is (width/2, max_height, depth/2)
        let root_bounds = AABB {
            min: Vec3::new(-grid_width / 2.0, -100.0, -grid_depth / 2.0),
            max: Vec3::new(grid_width / 2.0, max_height + 500.0, grid_depth / 2.0),
        };
        
        let octree = OctreeNode::new(root_bounds);

        Self {
            heightmap: heightmap_data,
            octree,
            grid_width,
            grid_depth,
            max_height,
        }
    }

    /// O(1) lookup to get the exact terrain elevation at a specific (X, Z) world coordinate
    pub fn get_terrain_height(&self, x: f32, z: f32) -> f32 {
        if self.heightmap.is_empty() || self.heightmap[0].is_empty() {
            return 0.0;
        }
        
        let rows = self.heightmap.len();
        let cols = self.heightmap[0].len();
        
        // Map world coords back to 0..1 UV
        // Assuming terrain is centered at (0, 0)
        let u = (x + (self.grid_width / 2.0)) / self.grid_width;
        let v = 1.0 - ((z + (self.grid_depth / 2.0)) / self.grid_depth); // image Y is inverted typically
        
        // Clamp bounds
        if u < 0.0 || u >= 1.0 || v < 0.0 || v >= 1.0 {
            return 0.0;
        }
        
        let px = (u * (cols as f32 - 1.0)) as usize;
        let py = (v * (rows as f32 - 1.0)) as usize;
        
        self.heightmap[py][px]
    }

    /// Server-Authoritative Validation API
    /// Takes a starting position, an attempted ending position, and an `is_walking` flag.
    /// Returns the strictly legal end position. 
    /// If `is_walking` is false (e.g. spectator flycam), collision checks are bypassed.
    pub fn validate_movement(&self, start: Vec3, end: Vec3, collision_radius: f32, is_walking: bool) -> Vec3 {
        if !is_walking {
            return end;
        }

        let mut final_pos = end;
        
        // 1. Terrain Collision (Instant O(1) Array Check)
        let floor_height = self.get_terrain_height(final_pos.x, final_pos.z);
        if final_pos.y < floor_height {
            final_pos.y = floor_height; // Correct the player to stand exactly on the ground
        }
        
        // 2. 3D Object/Player Collision (Octree Spatial Query)
        // Construct a bounding box for the movement sweep
        let sweep_aabb = AABB {
            min: Vec3::new(
                start.x.min(final_pos.x) - collision_radius,
                start.y.min(final_pos.y) - collision_radius,
                start.z.min(final_pos.z) - collision_radius,
            ),
            max: Vec3::new(
                start.x.max(final_pos.x) + collision_radius,
                start.y.max(final_pos.y) + collision_radius,
                start.z.max(final_pos.z) + collision_radius,
            ),
        };
        
        let mut potential_hits = Vec::new();
        self.octree.query(&sweep_aabb, &mut potential_hits);
        
        // Evaluate hits against our sweeping radius
        for obj in potential_hits {
            // Basic AABB push-out logic for Anti-Cheat
            // If we intersect a solid, we constrain the final_pos.
            // (Real implementation would slide along the normal vector, but for now we clamp).
            if final_pos.x >= obj.bounds.min.x - collision_radius && final_pos.x <= obj.bounds.max.x + collision_radius &&
               final_pos.z >= obj.bounds.min.z - collision_radius && final_pos.z <= obj.bounds.max.z + collision_radius &&
               final_pos.y >= obj.bounds.min.y - collision_radius && final_pos.y <= obj.bounds.max.y + collision_radius {
               
                // Simplistic clamp to previous valid position on XZ plane if hitting a wall
                final_pos.x = start.x;
                final_pos.z = start.z;
            }
        }
        
        final_pos
    }
}
