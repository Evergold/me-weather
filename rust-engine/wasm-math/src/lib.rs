use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct CullingEngine {
    culling_radius: f32,
    input_buffer: Vec<f32>,
    output_buffer: Vec<f32>,
}

#[wasm_bindgen]
impl CullingEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(culling_radius: f32) -> CullingEngine {
        CullingEngine {
            culling_radius,
            input_buffer: Vec::new(),
            output_buffer: Vec::new(),
        }
    }

    /// Resize the input buffer to accommodate the number of players.
    /// Returns the pointer to the start of the input buffer.
    #[wasm_bindgen]
    pub fn allocate_input(&mut self, size: usize) -> *mut f32 {
        self.input_buffer.resize(size, 0.0);
        self.input_buffer.as_mut_ptr()
    }

    /// Evaluates which players are within the culling radius.
    /// Operates entirely on pre-allocated WASM memory (zero-copy).
    /// Returns the number of visible players (length of output).
    #[wasm_bindgen]
    pub fn cull_players(&mut self, local_x: f32, local_z: f32) -> usize {
        self.output_buffer.clear();
        
        let radius_sq = self.culling_radius * self.culling_radius;

        // Auto-vectorized SIMD loop
        for chunk in self.input_buffer.chunks_exact(4) {
            let id = chunk[0];
            let px = chunk[1];
            let py = chunk[2];
            let pz = chunk[3];

            let dx = px - local_x;
            let dz = pz - local_z;
            let dist_sq = dx * dx + dz * dz;

            if dist_sq <= radius_sq {
                self.output_buffer.push(id);
                self.output_buffer.push(px);
                self.output_buffer.push(py);
                self.output_buffer.push(pz);
            }
        }

        self.output_buffer.len()
    }

    /// Returns the pointer to the output buffer so JS can read it.
    #[wasm_bindgen]
    pub fn get_output_ptr(&self) -> *const f32 {
        self.output_buffer.as_ptr()
    }
}
