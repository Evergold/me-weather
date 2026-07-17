import * as BABYLON from '@babylonjs/core';
import cullShaderCode from './cull.wgsl?raw';

export class TerrainCuller {
    constructor(engine) {
        this.engine = engine;
        // WebGPU compute culling
        this.isSupported = engine.isWebGPU;
        
        if (this.isSupported) {
            this.initComputeShader();
            
            // Persistent buffer tracking
            this.tilesCapacity = 0;
            this.tilesBuffer = null;
            this.visibleTilesBuffer = null;
            this.visibleCountBuffer = null;
        } else {
            // Web Worker Wasm Fallback for WebGL
            this.initWasmWorker();
        }
    }

    initWasmWorker() {
        this.worker = new Worker(new URL('./workers/culling_worker.js', import.meta.url), { type: 'module' });
        
        // Pre-allocate SharedArrayBuffers for 4096 tiles (8 floats each)
        // Note: SAB requires COOP/COEP headers to be active
        try {
            this.inputSab = new SharedArrayBuffer(4096 * 8 * 4); // 4096 tiles * 8 floats * 4 bytes
            this.outputSab = new SharedArrayBuffer(4096 * 4);    // 4096 tiles * 1 uint * 4 bytes
            
            this.inputView = new Float32Array(this.inputSab);
            this.outputView = new Uint32Array(this.outputSab);
            
            this.worker.postMessage({
                type: 'INIT',
                payload: {
                    inputSab: this.inputSab,
                    outputSab: this.outputSab
                }
            });
            
            this.wasmReady = new Promise(resolve => {
                this.worker.addEventListener('message', (e) => {
                    if (e.data.type === 'INIT_DONE') resolve();
                }, { once: true });
            });
        } catch (e) {
            console.error("[TerrainCuller] SharedArrayBuffer not available (check COOP/COEP headers). Falling back to pure JS culling.");
            this.worker = null;
        }
    }

    initComputeShader() {
        this.computeShader = new BABYLON.ComputeShader(
            "frustumCulling",
            this.engine,
            { computeSource: cullShaderCode },
            {
                bindingsMapping: {
                    "frustum": { group: 0, binding: 0 },
                    "tiles": { group: 0, binding: 1 },
                    "visible_tiles": { group: 0, binding: 2 },
                    "visible_count": { group: 0, binding: 3 },
                }
            }
        );
        
        this.frustumBuffer = new BABYLON.UniformBuffer(this.engine, undefined, undefined, "frustumBuffer");
        this.frustumBuffer.addUniform("planes", 4, 6);
        this.frustumBuffer.addUniform("tileCount", 1);
        this.frustumBuffer.addUniform("padding1", 1);
        this.frustumBuffer.addUniform("padding2", 1);
        this.frustumBuffer.addUniform("padding3", 1);
    }

    async cullTilesAsync(camera, tilesArray) {
        if (!this.isSupported || tilesArray.length === 0) {
            if (this.worker && this.wasmReady) {
                return this.wasmCullFallbackAsync(camera, tilesArray);
            }
            return this.cpuCullFallback(camera, tilesArray);
        }

        const tileCount = tilesArray.length;

        const tilesData = new Float32Array(tileCount * 12);
        const tilesDataUint = new Uint32Array(tilesData.buffer);

        for (let i = 0; i < tileCount; i++) {
            const t = tilesArray[i];
            const offset = i * 12;
            
            tilesData[offset + 0] = t.min.x;
            tilesData[offset + 1] = t.min.y;
            tilesData[offset + 2] = t.min.z;
            tilesData[offset + 3] = 0.0; 
            
            tilesData[offset + 4] = t.max.x;
            tilesData[offset + 5] = t.max.y;
            tilesData[offset + 6] = t.max.z;
            tilesData[offset + 7] = 0.0; 

            tilesDataUint[offset + 8] = i; 
        }

        if (tileCount > this.tilesCapacity) {
            this.tilesCapacity = Math.max(tileCount, this.tilesCapacity * 2 || 1024);
            
            if (this.tilesBuffer) this.tilesBuffer.dispose();
            if (this.visibleTilesBuffer) this.visibleTilesBuffer.dispose();
            if (this.visibleCountBuffer) this.visibleCountBuffer.dispose();
            
            this.tilesBuffer = new BABYLON.StorageBuffer(this.engine, this.tilesCapacity * 48);
            this.visibleTilesBuffer = new BABYLON.StorageBuffer(this.engine, this.tilesCapacity * 4);
            this.visibleCountBuffer = new BABYLON.StorageBuffer(this.engine, 4);
            
            this.computeShader.setStorageBuffer("tiles", this.tilesBuffer);
            this.computeShader.setStorageBuffer("visible_tiles", this.visibleTilesBuffer);
            this.computeShader.setStorageBuffer("visible_count", this.visibleCountBuffer);
        }

        this.tilesBuffer.update(tilesData);
        this.visibleCountBuffer.update(new Uint32Array([0]));

        const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());
        for (let i = 0; i < 6; i++) {
            const p = frustumPlanes[i];
            this.frustumBuffer.updateFloat4(
                "planes", 
                p.normal.x, p.normal.y, p.normal.z, p.d, 
                i
            );
        }
        this.frustumBuffer.updateInt("tileCount", tileCount);
        this.frustumBuffer.update();

        this.computeShader.setUniformBuffer("frustum", this.frustumBuffer);

        const workgroups = Math.ceil(tileCount / 64);
        this.computeShader.dispatch(workgroups, 1, 1);

        const countData = await this.visibleCountBuffer.read();
        const count = new Uint32Array(countData.buffer)[0];

        const visibleData = await this.visibleTilesBuffer.read();
        const visibleIndices = new Uint32Array(visibleData.buffer).slice(0, count);

        const visibleKeys = new Set();
        for (let i = 0; i < count; i++) {
            visibleKeys.add(tilesArray[visibleIndices[i]].key);
        }
        return visibleKeys;
    }

    async wasmCullFallbackAsync(camera, tilesArray) {
        await this.wasmReady;
        
        const tileCount = tilesArray.length;
        const numFloats = tileCount * 8;
        
        // Pack into SharedArrayBuffer (Float32Array)
        // [id, minX, minY, minZ, maxX, maxY, maxZ, pad]
        // Since id is uint, we cast it to float using a temporary buffer, or just store the index directly as float and parse it back
        for (let i = 0; i < tileCount; i++) {
            const t = tilesArray[i];
            const offset = i * 8;
            
            // Hack to pass uint ID through float buffer safely (since indices are small integers, they fit perfectly in f32)
            const idBuffer = new Uint32Array([i]);
            const idFloat = new Float32Array(idBuffer.buffer)[0];
            
            this.inputView[offset + 0] = idFloat;
            this.inputView[offset + 1] = t.min.x;
            this.inputView[offset + 2] = t.min.y;
            this.inputView[offset + 3] = t.min.z;
            this.inputView[offset + 4] = t.max.x;
            this.inputView[offset + 5] = t.max.y;
            this.inputView[offset + 6] = t.max.z;
            this.inputView[offset + 7] = 0.0;
        }
        
        const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());
        const planesArray = [];
        for (let i = 0; i < 6; i++) {
            const p = frustumPlanes[i];
            planesArray.push(p.normal.x, p.normal.y, p.normal.z, p.d);
        }
        
        return new Promise(resolve => {
            const handler = (e) => {
                if (e.data.type === 'CULL_DONE') {
                    this.worker.removeEventListener('message', handler);
                    const { numVisibleTiles } = e.data.payload;
                    const visibleKeys = new Set();
                    for (let i = 0; i < numVisibleTiles; i++) {
                        const index = this.outputView[i];
                        visibleKeys.add(tilesArray[index].key);
                    }
                    resolve(visibleKeys);
                }
            };
            this.worker.addEventListener('message', handler);
            
            this.worker.postMessage({
                type: 'CULL_FRUSTUM',
                payload: {
                    planes: planesArray,
                    numFloats: numFloats
                }
            });
        });
    }

    cpuCullFallback(camera, tilesArray) {
        const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());
        const visibleKeys = new Set();
        
        for (const t of tilesArray) {
            let visible = true;
            for (let p = 0; p < 6; p++) {
                const plane = frustumPlanes[p];
                const pVertex = new BABYLON.Vector3(
                    plane.normal.x >= 0 ? t.max.x : t.min.x,
                    plane.normal.y >= 0 ? t.max.y : t.min.y,
                    plane.normal.z >= 0 ? t.max.z : t.min.z
                );
                
                if (BABYLON.Vector3.Dot(plane.normal, pVertex) + plane.d < 0) {
                    visible = false;
                    break;
                }
            }
            if (visible) {
                visibleKeys.add(t.key);
            }
        }
        
        return visibleKeys;
    }
}
