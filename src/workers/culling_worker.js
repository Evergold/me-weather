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
    const wasm = await init();
    memory = wasm.memory;
    engine = new CullingEngine();
    
    // Cache the SharedArrayBuffers provided by the main thread
    sharedInputView = new Float32Array(payload.inputSab);
    sharedOutputView = new Uint32Array(payload.outputSab);
    
    self.postMessage({ type: 'INIT_DONE' });
  } 
  else if (type === 'CULL_FRUSTUM') {
    if (!engine || !memory) return;

    const { planes, numFloats } = payload;
    
    // 1. Resize Wasm memory buffer if incoming tile data is larger than current capacity
    if (numFloats > inputCapacity) {
      inputPtr = engine.allocate_input(numFloats);
      inputCapacity = numFloats;
    }

    // 2. Zero-Copy Write: Pull data from the Main Thread's SharedArrayBuffer directly into Wasm memory
    const wasmInputView = new Float32Array(memory.buffer, inputPtr, numFloats);
    wasmInputView.set(sharedInputView.subarray(0, numFloats));

    // 3. Execute SIMD-accelerated Frustum math entirely in Wasm
    const numVisibleTiles = engine.cull_frustum(new Float32Array(planes));

    // 4. Zero-Copy Read: Push data from Wasm memory directly into the Main Thread's Output SharedArrayBuffer
    const outputPtr = engine.get_output_ptr();
    const wasmOutputView = new Uint32Array(memory.buffer, outputPtr, numVisibleTiles);
    sharedOutputView.set(wasmOutputView);

    // 5. Notify the main thread.
    self.postMessage({
      type: 'CULL_DONE',
      payload: { numVisibleTiles }
    });
  }
};
