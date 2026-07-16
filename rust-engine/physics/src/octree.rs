use serde::{Serialize, Deserialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AABB {
    pub min: Vec3,
    pub max: Vec3,
}

impl AABB {
    pub fn intersects(&self, other: &AABB) -> bool {
        self.min.x <= other.max.x && self.max.x >= other.min.x &&
        self.min.y <= other.max.y && self.max.y >= other.min.y &&
        self.min.z <= other.max.z && self.max.z >= other.min.z
    }

    pub fn contains(&self, point: &Vec3) -> bool {
        point.x >= self.min.x && point.x <= self.max.x &&
        point.y >= self.min.y && point.y <= self.max.y &&
        point.z >= self.min.z && point.z <= self.max.z
    }
}

// A generic primitive for the Octree. Can represent a player, a rock, or a terrain tile.
#[derive(Clone, Debug)]
pub struct Collidable {
    pub id: u64,
    pub bounds: AABB,
    pub is_static: bool,
}

pub struct OctreeNode {
    pub bounds: AABB,
    pub objects: Vec<Collidable>,
    pub children: Option<Box<[OctreeNode; 8]>>,
}

impl OctreeNode {
    pub fn new(bounds: AABB) -> Self {
        Self {
            bounds,
            objects: Vec::new(),
            children: None,
        }
    }

    pub fn insert(&mut self, obj: Collidable, depth: u32, max_depth: u32) -> bool {
        if !self.bounds.intersects(&obj.bounds) {
            return false;
        }

        // If we are at a leaf node and we exceed threshold, try subdividing
        if self.children.is_none() && self.objects.len() >= 8 && depth < max_depth {
            self.subdivide();
        }

        if let Some(children) = &mut self.children {
            let mut inserted_in_child = false;
            for child in children.iter_mut() {
                if child.insert(obj.clone(), depth + 1, max_depth) {
                    inserted_in_child = true;
                }
            }
            if inserted_in_child {
                return true;
            }
        }

        // If it didn't fit neatly into children (e.g. straddles a boundary), or no children exist
        self.objects.push(obj);
        true
    }

    fn subdivide(&mut self) {
        let min = self.bounds.min;
        let max = self.bounds.max;
        let mid = Vec3::new(
            (min.x + max.x) / 2.0,
            (min.y + max.y) / 2.0,
            (min.z + max.z) / 2.0,
        );

        self.children = Some(Box::new([
            // Bottom 4
            OctreeNode::new(AABB { min: Vec3::new(min.x, min.y, min.z), max: Vec3::new(mid.x, mid.y, mid.z) }),
            OctreeNode::new(AABB { min: Vec3::new(mid.x, min.y, min.z), max: Vec3::new(max.x, mid.y, mid.z) }),
            OctreeNode::new(AABB { min: Vec3::new(min.x, min.y, mid.z), max: Vec3::new(mid.x, mid.y, max.z) }),
            OctreeNode::new(AABB { min: Vec3::new(mid.x, min.y, mid.z), max: Vec3::new(max.x, mid.y, max.z) }),
            // Top 4
            OctreeNode::new(AABB { min: Vec3::new(min.x, mid.y, min.z), max: Vec3::new(mid.x, max.y, mid.z) }),
            OctreeNode::new(AABB { min: Vec3::new(mid.x, mid.y, min.z), max: Vec3::new(max.x, max.y, mid.z) }),
            OctreeNode::new(AABB { min: Vec3::new(min.x, mid.y, mid.z), max: Vec3::new(mid.x, max.y, max.z) }),
            OctreeNode::new(AABB { min: Vec3::new(mid.x, mid.y, mid.z), max: Vec3::new(max.x, max.y, max.z) }),
        ]));
    }

    pub fn query(&self, range: &AABB, found: &mut Vec<Collidable>) {
        if !self.bounds.intersects(range) {
            return;
        }

        for obj in &self.objects {
            if obj.bounds.intersects(range) {
                found.push(obj.clone());
            }
        }

        if let Some(children) = &self.children {
            for child in children.iter() {
                child.query(range, found);
            }
        }
    }
}
