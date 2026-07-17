use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct CullingEngine {
    input_buffer: Vec<f32>,
    output_buffer: Vec<u32>,
}

#[wasm_bindgen]
impl CullingEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> CullingEngine {
        CullingEngine {
            input_buffer: Vec::new(),
            output_buffer: Vec::new(),
        }
    }

    /// Resize the input buffer to accommodate the number of tiles (8 floats per tile).
    #[wasm_bindgen]
    pub fn allocate_input(&mut self, size: usize) -> *mut f32 {
        self.input_buffer.resize(size, 0.0);
        self.input_buffer.as_mut_ptr()
    }

    /// Evaluates which tiles intersect the frustum.
    /// Operates entirely on pre-allocated WASM memory (zero-copy).
    /// Returns the number of visible tiles.
    #[wasm_bindgen]
    pub fn cull_frustum(&mut self, planes: &[f32]) -> usize {
        self.output_buffer.clear();
        
        // Auto-vectorized SIMD loop
        for chunk in self.input_buffer.chunks_exact(8) {
            let id = chunk[0].to_bits(); // We stored ID as float bits
            let min_x = chunk[1];
            let min_y = chunk[2];
            let min_z = chunk[3];
            let max_x = chunk[4];
            let max_y = chunk[5];
            let max_z = chunk[6];
            // chunk[7] is padding

            let mut visible = true;

            // Check against all 6 planes
            for p in planes.chunks_exact(4) {
                let px = if p[0] >= 0.0 { max_x } else { min_x };
                let py = if p[1] >= 0.0 { max_y } else { min_y };
                let pz = if p[2] >= 0.0 { max_z } else { min_z };
                
                let dot = p[0] * px + p[1] * py + p[2] * pz + p[3];
                if dot < 0.0 {
                    visible = false;
                    break;
                }
            }

            if visible {
                self.output_buffer.push(id);
            }
        }

        self.output_buffer.len()
    }

    /// Returns the pointer to the output buffer so JS can read it.
    #[wasm_bindgen]
    pub fn get_output_ptr(&self) -> *const u32 {
        self.output_buffer.as_ptr()
    }
}
