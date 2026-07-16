import * as BABYLON from '@babylonjs/core';
import cullShaderCode from './cull.wgsl?raw';

export class TerrainCuller {
    constructor(engine) {
        this.engine = engine;
        // Re-enabled WebGPU compute culling with persistent buffers to scale to millions of objects
        this.isSupported = engine.isWebGPU;
        
        if (this.isSupported) {
            this.initComputeShader();
            
            // Persistent buffer tracking to prevent memory leaks
            this.tilesCapacity = 0;
            this.tilesBuffer = null;
            this.visibleTilesBuffer = null;
            this.visibleCountBuffer = null;
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
        
        // We will initialize buffers dynamically based on grid size
        this.frustumBuffer = new BABYLON.UniformBuffer(this.engine, undefined, undefined, "frustumBuffer");
        // 6 planes * 4 floats (vec3 + dist padded to vec4) = 24 floats = 96 bytes
        this.frustumBuffer.addUniform("planes", 4, 6);
        // WGSL struct requires 16-byte alignment padding (4 floats = 16 bytes)
        this.frustumBuffer.addUniform("tileCount", 1);
        this.frustumBuffer.addUniform("padding1", 1);
        this.frustumBuffer.addUniform("padding2", 1);
        this.frustumBuffer.addUniform("padding3", 1);
    }

    async cullTilesAsync(camera, tilesArray) {
        if (!this.isSupported || tilesArray.length === 0) {
            // CPU Fallback if WebGL2
            return this.cpuCullFallback(camera, tilesArray);
        }

        const tileCount = tilesArray.length;

        // 1. Pack Tiles into Storage Buffer
        // AABB (min vec3 + pad, max vec3 + pad) = 8 floats
        // id u32 + pad = 4 uints
        // Total = 12 floats/uints = 48 bytes per tile
        const tilesData = new Float32Array(tileCount * 12);
        const tilesDataUint = new Uint32Array(tilesData.buffer);

        for (let i = 0; i < tileCount; i++) {
            const t = tilesArray[i];
            const offset = i * 12;
            
            tilesData[offset + 0] = t.min.x;
            tilesData[offset + 1] = t.min.y;
            tilesData[offset + 2] = t.min.z;
            tilesData[offset + 3] = 0.0; // pad
            
            tilesData[offset + 4] = t.max.x;
            tilesData[offset + 5] = t.max.y;
            tilesData[offset + 6] = t.max.z;
            tilesData[offset + 7] = 0.0; // pad

            tilesDataUint[offset + 8] = i; // id (index)
        }

        // Dynamically reallocate persistent buffers only when capacity is exceeded
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

        // 2. Update Frustum Planes
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

        // 3. Bind and Dispatch
        this.computeShader.setUniformBuffer("frustum", this.frustumBuffer);
        // (Storage buffers are bound persistently during allocation)

        const workgroups = Math.ceil(tileCount / 64);
        this.computeShader.dispatch(workgroups, 1, 1);

        // 4. Readback results
        const countData = await this.visibleCountBuffer.read();
        const count = new Uint32Array(countData.buffer)[0];

        // Only slice the exact number of visible items read from the persistent buffer
        const visibleData = await this.visibleTilesBuffer.read();
        const visibleIndices = new Uint32Array(visibleData.buffer).slice(0, count);

        // Map back to original keys
        const visibleKeys = new Set();
        for (let i = 0; i < count; i++) {
            visibleKeys.add(tilesArray[visibleIndices[i]].key);
        }
        return visibleKeys;
    }

    cpuCullFallback(camera, tilesArray) {
        const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());
        const visibleKeys = new Set();
        
        let logFrustum = false;
        if (!this.hasLoggedFrustum) {
            console.log(`[CPU Cull] Canvas size: ${camera.getEngine().getRenderWidth()}x${camera.getEngine().getRenderHeight()}`);
            console.log(`[CPU Cull] First plane: `, frustumPlanes[0].normal.x, frustumPlanes[0].d);
            this.hasLoggedFrustum = true;
            logFrustum = true;
        }
        
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
        
        if (logFrustum) {
            console.log(`[CPU Cull] Returning ${visibleKeys.size} visible keys. First key: ${[...visibleKeys][0]}`);
        }
        return visibleKeys;
    }
}
