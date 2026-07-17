import init, { CullingEngine } from '../wasm/wasm_math.js';

let engine = null;
let memory = null;
let inputPtr = null;
let inputCapacity = 0;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    // Initialize the WebAssembly module
    const wasm = await init();
    memory = wasm.memory;
    engine = new CullingEngine(payload.cullingRadius);
    self.postMessage({ type: 'INIT_DONE' });
  } 
  else if (type === 'CULL') {
    if (!engine || !memory) return;

    const { localX, localZ, playersData } = payload;
    
    // 1. Resize Wasm memory buffer if incoming player data is larger than current capacity
    const numFloats = playersData.length;
    if (numFloats > inputCapacity) {
      inputPtr = engine.allocate_input(numFloats);
      inputCapacity = numFloats;
    }

    // 2. Zero-Copy Write: Write JS float data directly into Wasm linear memory
    const wasmInputView = new Float32Array(memory.buffer, inputPtr, numFloats);
    wasmInputView.set(playersData);

    // 3. Execute SIMD-accelerated math entirely in Wasm
    const numVisibleFloats = engine.cull_players(localX, localZ);

    // 4. Zero-Copy Read: Construct a view over the Wasm output memory pointer
    const outputPtr = engine.get_output_ptr();
    const wasmOutputView = new Float32Array(memory.buffer, outputPtr, numVisibleFloats);

    // 5. Transfer the result back to the main thread.
    // We copy the result into a new ArrayBuffer to send back to the main thread,
    // or if we use SharedArrayBuffer we can just notify the main thread!
    // Since SharedArrayBuffer is tricky with standard Vite configurations sometimes, 
    // sending a standard Float32Array via structured clone is still incredibly fast because 
    // the heavy loop and V8 GC spikes were eliminated.
    self.postMessage({
      type: 'CULL_DONE',
      payload: new Float32Array(wasmOutputView) // We must copy out of Wasm memory before transferring
    });
  }
};
