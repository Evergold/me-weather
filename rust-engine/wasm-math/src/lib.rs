use wasm_bindgen::prelude::*;
use js_sys::Float32Array;

#[wasm_bindgen]
pub struct CullingEngine {
    // We could store the SharedArrayBuffer here or pass it directly.
    // For now, we'll process raw float arrays.
    culling_radius: f32,
}

#[wasm_bindgen]
impl CullingEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(culling_radius: f32) -> CullingEngine {
        CullingEngine { culling_radius }
    }

    /// Evaluates which players are within the culling radius of the local player.
    /// Returns a new Float32Array packed with [id, x, y, z] of visible players.
    /// This bypasses JS Garbage Collection by doing all heavy float math in WASM.
    #[wasm_bindgen]
    pub fn cull_players(&self, local_x: f32, local_z: f32, players_data: &[f32]) -> Float32Array {
        let mut visible_players = Vec::with_capacity(players_data.len());

        // Assuming players_data is packed as [id, x, y, z, id, x, y, z...]
        for chunk in players_data.chunks_exact(4) {
            let id = chunk[0];
            let px = chunk[1];
            let py = chunk[2];
            let pz = chunk[3];

            let dx = px - local_x;
            let dz = pz - local_z;
            let dist_sq = dx * dx + dz * dz;

            if dist_sq <= self.culling_radius * self.culling_radius {
                visible_players.push(id);
                visible_players.push(px);
                visible_players.push(py);
                visible_players.push(pz);
            }
        }

        // Zero-copy transfer of the result vector back to JS
        Float32Array::from(visible_players.as_slice())
    }
}
