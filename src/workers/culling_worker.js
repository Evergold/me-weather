import init, { CullingEngine } from '../wasm/wasm_math.js';

let engine = null;
let memory = null;
let inputPtr = null;
let inputCapacity = 0;
let sharedInputView = null;
let sharedOutputView = null;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    // Initialize the WebAssembly module
    const wasm = await init();
    memory = wasm.memory;
    engine = new CullingEngine(payload.cullingRadius);
    
    // Cache the SharedArrayBuffers provided by the main thread
    sharedInputView = new Float32Array(payload.inputSab);
    sharedOutputView = new Float32Array(payload.outputSab);
    
    self.postMessage({ type: 'INIT_DONE' });
  } 
  else if (type === 'CULL') {
    if (!engine || !memory) return;

    const { localX, localZ, numFloats } = payload;
    
    // 1. Resize Wasm memory buffer if incoming player data is larger than current capacity
    if (numFloats > inputCapacity) {
      inputPtr = engine.allocate_input(numFloats);
      inputCapacity = numFloats;
    }

    // 2. Zero-Copy Write: Pull data from the Main Thread's SharedArrayBuffer directly into Wasm memory
    const wasmInputView = new Float32Array(memory.buffer, inputPtr, numFloats);
    wasmInputView.set(sharedInputView.subarray(0, numFloats));

    // 3. Execute SIMD-accelerated math entirely in Wasm
    const numVisibleFloats = engine.cull_players(localX, localZ);

    // 4. Zero-Copy Read: Push data from Wasm memory directly into the Main Thread's Output SharedArrayBuffer
    const outputPtr = engine.get_output_ptr();
    const wasmOutputView = new Float32Array(memory.buffer, outputPtr, numVisibleFloats);
    sharedOutputView.set(wasmOutputView);

    // 5. Notify the main thread.
    // The main thread can instantly read outputSab without ANY serialization/deserialization!
    self.postMessage({
      type: 'CULL_DONE',
      payload: { numVisibleFloats }
    });
  }
};
