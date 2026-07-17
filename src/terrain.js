// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';
import { TerrainCuller } from './TerrainCuller.js';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.culler = new TerrainCuller(scene.getEngine());
    this.activeTiles = new Map(); // Key: "z_x_y" -> Value: { mesh, material, heightTex, normalTex, flowTex, sps, spsMesh, loaded }
    
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    
    this.currentZoom = 0;
    this.initialTilesLoaded = false;
    
    // Cache for material uniform values to apply to newly created tiles
    this.uniforms = {
      uScale: 250.0,
      uMorphProgress: 1.0,
      activeLayer: 0,
      timeOfDay: 480.0,
      uLightDir: new BABYLON.Vector3(-0.5, -0.8, -0.5),
      uLightColor: new BABYLON.Color3(1.0, 1.0, 1.0),
      uIsZoomed: 0.0,
      uWeatherOffset: new BABYLON.Vector2(0.0, 0.0),
      uWeatherScale: 1.0,
      uSeason: 1,
      uTime: 0.0
    };
    
    this.weatherTex = null;
    
    this.initShaders();
    this.initWeatherTexture();
    this.initTreeTemplate();
  }
  
  initShaders() {
    BABYLON.Effect.ShadersStore["weatherTerrainVertexShader"] = `
      precision highp float;
      attribute vec3 position;
      attribute vec2 uv;
      uniform mat4 world;
      uniform mat4 view;
      uniform mat4 projection;
      uniform mat4 worldViewProjection;

      uniform sampler2D tHeight;
      uniform sampler2D tHeightPrev;
      uniform sampler2D tNormal;
      uniform float uScale;
      uniform float uMorphProgress;
      uniform vec2 uTileOffset;
      uniform float uTileScale;
      uniform float uParentUvScale;
      uniform vec2 uParentUvOffset;

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vUv = uv;
        // Calculate global UV coordinates relative to the full terrain grid
        float tilesCount = 1.0 / uTileScale;
        vUvGlobal = vec2(
          uTileOffset.x * uTileScale + uv.x * uTileScale,
          uTileOffset.y * uTileScale + uv.y * uTileScale
        );
        // Flawless Geomorphing: interpolate from parent tile texture to child tile texture
        vec2 clampedUv = clamp(uv, 0.002, 0.998);
        float hTarget = textureLod(tHeight, clampedUv, 0.0).r;
        
        vec2 parentUv;
        if (uParentUvScale > 0.0) {
            parentUv = uv * uParentUvScale + uParentUvOffset;
        } else {
            parentUv = vUvGlobal;
        }
        float hPrev = textureLod(tHeightPrev, clamp(parentUv, 0.002, 0.998), 0.0).r;
        float height = mix(hPrev, hTarget, uMorphProgress);
        vHeight = height;
        
        vec3 pos = position;
        pos.y = height * uScale;
        
        vec4 worldPos = world * vec4(pos, 1.0);
        vPosition = worldPos.xyz;
        
        vec3 n = textureLod(tNormal, clampedUv, 0.0).rgb * 2.0 - 1.0;
        vNormal = normalize((world * vec4(n, 0.0)).xyz);
        
        gl_Position = worldViewProjection * vec4(pos, 1.0);
      }
    `;

    BABYLON.Effect.ShadersStore["weatherTerrainFragmentShader"] = `
      precision highp float;
      uniform sampler2D tNormal;
      uniform sampler2D tWeather;
      uniform sampler2D tFlow;
      
      uniform int activeLayer;
      uniform float timeOfDay;
      uniform vec3 uLightDir;
      uniform vec3 uLightColor;
      
      uniform vec2 uWeatherOffset;
      uniform float uWeatherScale;
      uniform float uIsZoomed;
      
      uniform int uSeason;
      uniform float uTime;
      uniform vec3 vEyePosition;
      uniform sampler2D tHeight;

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        // --- PARALLAX OCCLUSION MAPPING (POM) ---
        // Raymarch the local depth to give flat polygons true volumetric depth
        vec3 viewDir = normalize(vEyePosition - vPosition);
        
        // Approximate Tangent Space (Terrain is mostly XZ flat)
        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);
        vec3 vertexNormal = vec3(0.0, 1.0, 0.0);
        mat3 tbn = mat3(tangent, binormal, vertexNormal);
        
        vec3 viewDirTS = normalize(viewDir * tbn);
        
        // POM Setup
        float numLayers = mix(32.0, 8.0, abs(dot(vec3(0.0, 1.0, 0.0), viewDir))); // More layers at glancing angles
        float layerDepth = 1.0 / numLayers;
        float currentLayerDepth = 0.0;
        
        // Parallax depth scale
        float parallaxScale = 0.015; 
        vec2 P = viewDirTS.xz * parallaxScale; 
        vec2 deltaTexCoords = P / numLayers;
        
        vec2 texCoords = vUv;
        // Generate pseudo-micro-depth from the flowmap and normal map to give rocks/rivers deep ridges
        float currentDepthMapValue = 1.0 - textureLod(tHeight, clamp(texCoords, 0.002, 0.998), 0.0).r;
        
        // Raymarch loop
        for(int i = 0; i < 32; i++) {
            if (currentLayerDepth >= currentDepthMapValue) break;
            texCoords -= deltaTexCoords;
            currentDepthMapValue = 1.0 - textureLod(tHeight, clamp(texCoords, 0.002, 0.998), 0.0).r;
            currentLayerDepth += layerDepth;
        }
        
        // Relief Mapping Refinement (Binary Search)
        vec2 prevTexCoords = texCoords + deltaTexCoords;
        float afterDepth  = currentDepthMapValue - currentLayerDepth;
        float beforeDepth = (1.0 - textureLod(tHeight, clamp(prevTexCoords, 0.002, 0.998), 0.0).r) - currentLayerDepth + layerDepth;
        float weight = afterDepth / max(afterDepth - beforeDepth, 0.0001);
        vec2 finalTexCoords = prevTexCoords * weight + texCoords * (1.0 - weight);
        
        vec2 pomUv = clamp(finalTexCoords, 0.002, 0.998);
        
        vec3 normal = normalize(vNormal);
        
        // Sample static hydrology flowmap with POM UVs
        vec3 flowData = texture2D(tFlow, pomUv).rgb;
        vec2 flowDir = normalize(flowData.rg * 2.0 - 1.0 + 1e-5);
        float flowStrength = flowData.b;
        
        // Flow speed scales with river width
        float speedMultiplier = max(0.2, flowStrength * 1.5);
        float progress1 = fract(uTime * 0.08 * speedMultiplier);
        float progress2 = fract(uTime * 0.08 * speedMultiplier + 0.5);
        
        vec2 uvOffset1 = flowDir * progress1 * 0.08;
        vec2 uvOffset2 = flowDir * progress2 * 0.08;
        
        // Glacial Shear: Extremely slow movement down the slope gradient
        vec2 glacierOffset = flowDir * fract(uTime * 0.002) * 0.15;
        
        // Sample normal maps at top-level with POM UVs
        vec3 n1 = texture2D(tNormal, clamp(pomUv - uvOffset1, 0.002, 0.998)).rgb * 2.0 - 1.0;
        vec3 n2 = texture2D(tNormal, clamp(pomUv - uvOffset2, 0.002, 0.998)).rgb * 2.0 - 1.0;
        vec3 nGlacier = texture2D(tNormal, clamp(pomUv - glacierOffset, 0.002, 0.998)).rgb * 2.0 - 1.0;

        // Rivers are carved where flow accumulation is high (Blue channel > 0.15)
        bool isWaterBody = false;
        if (vHeight < 0.08) {
          isWaterBody = true;
        } else if (activeLayer == 0) {
          if (flowStrength > 0.15) {
            if (vHeight < 0.22) {
              isWaterBody = true;
            }
          }
        }
        
        if (isWaterBody) {
          float blend = abs(0.5 - progress1) / 0.5;
          vec3 normalPerturb = normalize(mix(n1, n2, blend));
          normal = normalize(normal + normalPerturb * 0.35);
        }

        vec3 lightDir = normalize(-uLightDir);
        float diffuse = max(0.12, dot(normal, lightDir));

        // Sample weather data using global UV coordinates across the entire Middle-earth grid,
        // adjusting if focused on a high-resolution regional chunk.
        vec2 weatherUv = vec2(vUvGlobal.x * uWeatherScale + uWeatherOffset.x, 
                              vUvGlobal.y * uWeatherScale + uWeatherOffset.y);
        vec4 wData = texture2D(tWeather, clamp(weatherUv, 0.0, 1.0));
        
        float temp = wData.r * 70.0 - 20.0;
        float moist = wData.g;
        float rain = wData.b;
        float snow = wData.a;

        vec3 baseColor = vec3(0.3, 0.45, 0.2);

        bool isTerrainOrMoisture = false;
        if (activeLayer == 0) {
          isTerrainOrMoisture = true;
        } else if (activeLayer == 2) {
          isTerrainOrMoisture = true;
        }
        
        if (isTerrainOrMoisture) {
          if (vHeight < 0.08) {
            baseColor = vec3(0.08, 0.18, 0.36); // Ocean
          } else if (isWaterBody) {
            // Billow Beer's Law style shading for river depth
            baseColor = mix(vec3(0.15, 0.32, 0.52), vec3(0.08, 0.18, 0.32), clamp((vHeight - 0.08) * 4.0, 0.0, 1.0));
          } else if (vHeight < 0.12) {
            baseColor = vec3(0.85, 0.82, 0.65); // Sand
          } else if (vHeight > 0.6) {
            baseColor = vec3(0.92, 0.96, 0.98); // Glacial Ice / Snow peaks
            
            // Phase 5: Glacial Shearing Normal Map
            // Blend the static terrain normal with the time-shifted shear normal
            // Creates the visual illusion of dynamic glacial shear stress slipping down the mountains
            float shearBlend = clamp((vHeight - 0.6) * 5.0, 0.0, 0.8);
            normal = normalize(mix(normal, nGlacier, shearBlend));
            // Enhance specular reflection on ice
            diffuse = max(0.12, dot(normal, lightDir)) * 1.2;
            
          } else if (vHeight > 0.45) {
            baseColor = vec3(0.45, 0.42, 0.38); // Rock
          } else {
            // Apply Seasonal Colors to vegetation
            vec3 grassColor = vec3(0.2, 0.4, 0.15); // Summer default
            if (uSeason == 0) {
              grassColor = vec3(0.22, 0.48, 0.12); // Spring: vibrant green
            } else if (uSeason == 2) {
              grassColor = mix(vec3(0.48, 0.32, 0.1), vec3(0.55, 0.25, 0.08), moist); // Autumn: warm orange/gold
            } else if (uSeason == 3) {
              grassColor = vec3(0.35, 0.32, 0.28); // Winter: dry frosty grey-brown
            }
            baseColor = mix(grassColor, vec3(0.12, 0.3, 0.1), wData.g);
          }

          if (activeLayer == 2) {
            if (moist > 0.35) {
              float blendFactor = (moist - 0.35) * 1.8;
              vec3 blueMoisture = vec3(0.05, 0.38, 0.85);
              baseColor = mix(baseColor, blueMoisture, clamp(blendFactor * 0.7, 0.0, 0.7));
            }
          }
        } else if (activeLayer == 1) {
          float normTemp = (temp + 10.0) / 45.0;
          baseColor = mix(vec3(0.0, 0.2, 0.8), vec3(0.9, 0.1, 0.1), clamp(normTemp, 0.0, 1.0));
        } else if (activeLayer == 3) {
          float press = 1013.0 - vHeight * 120.0;
          float normPress = (press - 890.0) / 130.0;
          baseColor = mix(vec3(0.25, 0.0, 0.4), vec3(0.85, 0.8, 0.1), clamp(normPress, 0.0, 1.0));
        }

        float hour = timeOfDay / 60.0;
        float nightFactor = max(0.12, sin((hour - 6.0) * 3.14159 / 12.0));
        vec3 ambient = vec3(0.16, 0.18, 0.24) * nightFactor;
        
        float brightnessBoost = 1.35;
        vec3 finalColor = baseColor * (diffuse * uLightColor * brightnessBoost + ambient);
        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;
  }
  
  initWeatherTexture() {
    // Initialize empty global weather texture once
    const defaultData = new Float32Array(this.terrainWidth * this.terrainHeight * 4);
    this.weatherTex = new BABYLON.RawTexture(
      defaultData,
      this.terrainWidth,
      this.terrainHeight,
      BABYLON.Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false, // Set to false to avoid WebGL/WebGPU driver-side y-flip deprecation warnings
      BABYLON.Texture.NEAREST_SAMPLINGMODE,
      BABYLON.Engine.TEXTURETYPE_FLOAT
    );
  }

  initTreeTemplate() {
    // Procedural Low-poly Pine Cone foliage template (bypasses MergeMeshes to prevent strict GLSL/WebGL hangs)
    const foliage = BABYLON.MeshBuilder.CreateCylinder("foliage", { height: 2.2, diameterTop: 0.0, diameterBottom: 1.2, tessellation: 5 }, this.scene);
    foliage.position.y = 1.1; // Center pivot at bottom
    
    const foliageColors = [];
    for (let i = 0; i < foliage.getTotalVertices(); i++) {
      foliageColors.push(0.22, 0.48, 0.12, 1.0); // Forest Green
    }
    foliage.setVerticesData("color", foliageColors);

    this.treeTemplate = foliage;
    this.treeTemplate.setEnabled(false);
    
    const treeMat = new BABYLON.StandardMaterial("treeMat", this.scene);
    treeMat.useVertexColors = true;
    treeMat.roughness = 0.85;
    this.treeTemplate.material = treeMat;
  }
  
  async updateTiles(camera, physics) {
    if (!camera || this.isUpdatingTiles) return;
    this.isUpdatingTiles = true;
    
    try {
    // Choose quadtree zoom level based on camera altitude (radius)
    let z = 0;
    if (camera.radius > 1500) {
      z = 0;
    } else if (camera.radius > 800) {
      z = 1;
    } else if (camera.radius > 400) {
      z = 2;
    } else {
      z = 3;
    }
    
    const tilesCount = Math.pow(2, z);
    const tileSize = 2000.0 / tilesCount;
    
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    
    // Build array of all potential tiles at this zoom level to send to the GPU culler
    const tilesArray = [];
    for (let x = 0; x < tilesCount; x++) {
      for (let y = 0; y < tilesCount; y++) {
        const tileStartX = -1000.0 + x * tileSize;
        const tileStartZ = -1000.0 + y * tileSize;
        
        tilesArray.push({
          key: `${z}_${x}_${y}`,
          min: new BABYLON.Vector3(tileStartX, 0, tileStartZ),
          max: new BABYLON.Vector3(tileStartX + tileSize, this.uniforms.uScale, tileStartZ + tileSize)
        });
      }
    }
    
    // Offload frustum intersection math to the WebGPU compute shader!
    const visibleKeys = await this.culler.cullTilesAsync(camera, tilesArray);
    
    // Create new tiles for target zoom z if they don't exist yet
    let allTargetTilesLoaded = true;
    for (const key of visibleKeys) {
      if (!this.activeTiles.has(key)) {
        const parts = key.split("_");
        const tx = parseInt(parts[1]);
        const ty = parseInt(parts[2]);
        this.createTile(z, tx, ty, tileSize, apiProtocol, apiHost, camera, physics);
      }
      
      const tile = this.activeTiles.get(key);
      if (tile && !tile.loaded) {
        allTargetTilesLoaded = false;
      }
    }
    
    // Check if we actually need a transition swap (zoom level changed, old tiles exist, or initial load)
    let needsSwap = this.currentZoom !== z || !this.initialTilesLoaded;
    if (!needsSwap) {
      for (const key of this.activeTiles.keys()) {
        const parts = key.split("_");
        const tileZ = parseInt(parts[0]);
        if (tileZ !== z || !visibleKeys.has(key)) {
          needsSwap = true;
          break;
        }
      }
    }
    
    if (!needsSwap) return;

    // Only perform the transition swap when all target zoom meshes are fully loaded.
    if (allTargetTilesLoaded) {
      // 1. Gather compilation promises without enabling the meshes yet to prevent single-frame pops
      const compilationPromises = [];
      for (const key of visibleKeys) {
        const tile = this.activeTiles.get(key);
        if (tile && tile.mesh) {
          if (tile.material) {
            compilationPromises.push(tile.material.forceCompilationAsync(tile.mesh));
          }
          if (tile.spsMesh && tile.spsMesh.material) {
            compilationPromises.push(tile.spsMesh.material.forceCompilationAsync(tile.spsMesh));
          }
        }
      }
      
      // 2. Wait for shaders to be fully compiled asynchronously before swapping
      this.isCompiling = true; // Trigger the UI 'finishing move' only while shaders are actually compiling
      await Promise.all(compilationPromises);
      
      this.isCompiling = false; // Triggers the UI 'finishing move' animation
      
      // Schedule the actual mesh swap to happen synchronously right before the next frame's active mesh evaluation.
      // This prevents the 1-frame black blink caused by async microtasks resolving mid-frame!
      await new Promise(resolve => {
        this.scene.onBeforeActiveMeshesEvaluationObservable.addOnce(() => {
          const isZoomIn = z > this.currentZoom;
          this.morphStartTime = performance.now();
          
          if (isZoomIn) {
            this.uniforms.uMorphProgress = 0.0;
            this.morphDirection = 1;
          } else {
            this.uniforms.uMorphProgress = 1.0;
            this.morphDirection = -1;
          }
          
          if (!this.pendingDisposals) this.pendingDisposals = [];
          if (!this.pendingEnables) this.pendingEnables = [];
          
          const keysToDelete = [];
          for (const [key, tile] of this.activeTiles.entries()) {
            const parts = key.split("_");
            const tileZ = parseInt(parts[0]);
            
            if (tileZ !== z || !visibleKeys.has(key)) {
              if (isZoomIn) {
                if (tile.mesh) tile.mesh.setEnabled(false); // Hide immediately on zoom in
              } else {
                if (tile.mesh) tile.mesh.setEnabled(true); // Keep visible on zoom out to morph down
              }
              this.pendingDisposals.push(tile); // Delay disposal until morph completes
              keysToDelete.push(key);
            } else {
              // Target tile handling
              if (isZoomIn) {
                // Zoom In: safely enable target tiles immediately (compilation is complete)
                if (tile.mesh) tile.mesh.setEnabled(true);
                if (tile.spsMesh) tile.spsMesh.setEnabled(true);
                if (tile.material) tile.material.setFloat("uMorphProgress", this.uniforms.uMorphProgress);
              } else {
                // Zoom Out: keep new tiles hidden until morph down completes
                if (tile.mesh) tile.mesh.setEnabled(false);
                if (tile.spsMesh) tile.spsMesh.setEnabled(false);
                // New tiles on zoom out should stay at their final shape (1.0)
                if (tile.material) tile.material.setFloat("uMorphProgress", 1.0);
                this.pendingEnables.push(tile);
              }
            }
          }
          
          if (!isZoomIn) {
            // Zoom Out: bind the correct newly loaded parent texture to the old children so they can morph down to it
            for (const oldTile of this.pendingDisposals) {
              if (oldTile.material && oldTile.mesh) {
                const parts = oldTile.mesh.name.split("_");
                const oldZ = parseInt(parts[1]);
                const oldX = parseInt(parts[2]);
                const oldY = parseInt(parts[3]);
                
                const diff = oldZ - z;
                const parentX = Math.floor(oldX / Math.pow(2, diff));
                const parentY = Math.floor(oldY / Math.pow(2, diff));
                const parentKey = `${z}_${parentX}_${parentY}`;
                
                let newParentTex = this.coarseHeightTex;
                if (this.activeTiles.has(parentKey)) {
                  newParentTex = this.activeTiles.get(parentKey).heightTex;
                }
                
                oldTile.material.setTexture("tHeightPrev", newParentTex);
              }
            }
          }
          
          for (const key of keysToDelete) {
            this.activeTiles.delete(key);
          }
          
          this.currentZoom = z;
          this.loadedTiles = this.loadedTiles || 0;
          this.loadedTiles += keysToDelete.length ? 0 : 1; // Basic tracking
          this.initialTilesLoaded = true;
          resolve();
        });
      });
    }
    } finally {
      this.isUpdatingTiles = false;
    }
  }
  
  createTile(z, x, y, tileSize, apiProtocol, apiHost, camera, physics) {
    const key = `${z}_${x}_${y}`;
    
    // Configure subdivision grid dynamically
    let subdivisions = 64;
    if (z === 0) subdivisions = 255;
    else if (z === 1) subdivisions = 128;
    else if (z === 2) subdivisions = 96;
    else subdivisions = 64;
    
    const mesh = BABYLON.MeshBuilder.CreateGround(
      `tile_${key}`,
      { width: tileSize, height: tileSize, subdivisions: subdivisions },
      this.scene
    );
    mesh.receiveShadows = true;
    mesh.alwaysSelectAsActiveMesh = true;
    
    // Place tile into correct grid coordinate slot in world space
    const posX = -1000.0 + x * tileSize + tileSize / 2.0;
    const posZ = -1000.0 + y * tileSize + tileSize / 2.0;
    mesh.position.set(posX, 0.0, posZ);
    
    const material = new BABYLON.ShaderMaterial(
      `tileMaterial_${key}`,
      this.scene,
      {
        vertex: "weatherTerrain",
        fragment: "weatherTerrain",
      },
      {
        attributes: ["position", "uv"],
        uniforms: [
          "world", "view", "projection", "worldViewProjection",
          "uScale", "uMorphProgress", "activeLayer", "timeOfDay",
          "uLightDir", "uLightColor", "uTileOffset", "uTileScale",
          "uWeatherOffset", "uWeatherScale", "uIsZoomed",
          "uSeason", "uTime", "uParentUvScale", "uParentUvOffset", "vEyePosition"
        ],
        samplers: ["tHeight", "tHeightPrev", "tNormal", "tWeather", "tFlow"]
      }
    );
    
    // Bind cached global variables
    material.setFloat("uScale", this.uniforms.uScale);
    material.setFloat("uMorphProgress", this.uniforms.uMorphProgress);
    material.setInt("activeLayer", this.uniforms.activeLayer);
    material.setFloat("timeOfDay", this.uniforms.timeOfDay);
    material.setVector3("uLightDir", this.uniforms.uLightDir);
    material.setColor3("uLightColor", this.uniforms.uLightColor);
    material.setFloat("uIsZoomed", this.uniforms.uIsZoomed);
    material.setVector2("uWeatherOffset", this.uniforms.uWeatherOffset);
    material.setFloat("uWeatherScale", this.uniforms.uWeatherScale);
    material.setInt("uSeason", this.uniforms.uSeason);
    material.setFloat("uTime", this.uniforms.uTime);
    
    // Register before render binding for dynamic camera position
    mesh.onBeforeRenderObservable.add(() => {
        material.setVector3("vEyePosition", camera.globalPosition);
    });
    
    // Bind tile-specific mapping offsets
    const tilesCount = Math.pow(2, z);
    material.setVector2("uTileOffset", new BABYLON.Vector2(x, y));
    material.setFloat("uTileScale", 1.0 / tilesCount);
    
    if (this.weatherTex) {
      material.setTexture("tWeather", this.weatherTex);
    }
    
    // Keep all initial tiles enabled immediately during the startup phase to prevent camera raycast target jumps/freezes
    if (!this.initialTilesLoaded) {
      mesh.setEnabled(true);
    } else {
      mesh.setEnabled(false);
    }
    
    const tileObj = {
      mesh,
      material,
      heightTex: null,
      normalTex: null,
      flowTex: null,
      sps: null,
      spsMesh: null,
      loaded: false
    };
    
    let texturesLoaded = 0;
    const checkLoaded = () => {
      texturesLoaded++;
      if (texturesLoaded === 3) { // Require height, normal, and flow maps to be fully loaded
        tileObj.loaded = true;
        if (z === this.currentZoom) {
          mesh.setEnabled(true);
        }
        
        // Dynamically instantiate instanced forest vegetation via SPS close up (Z >= 2)
        if (z >= 2) {
          this.buildVegetationSPS(tileObj, z, posX, posZ, tileSize, physics);
        }

        // Trigger updateTiles to check if all target tiles are loaded
        this.updateTiles(camera, physics);
      }
    };
    
    const serverY = tilesCount - 1 - y;
    const cacheBuster = "?v=2";
    
    const heightUrl = `/assets/tiles/${z}/height/${x}_${serverY}.png${cacheBuster}`;
    const heightTex = new BABYLON.Texture(
      heightUrl,
      this.scene,
      true,
      true, // invertY must be true to match Babylon texture coordinate mapping
      BABYLON.Texture.LINEAR_LINEAR,
      checkLoaded,
      (err) => console.warn(`Failed to load tile heightmap: ${heightUrl}`, err)
    );
    heightTex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    heightTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    
    const normalUrl = `/assets/tiles/${z}/normal/${x}_${serverY}.png${cacheBuster}`;
    const normalTex = new BABYLON.Texture(
      normalUrl,
      this.scene,
      true,
      true, // invertY must be true to match Babylon texture coordinate mapping
      BABYLON.Texture.LINEAR_LINEAR,
      checkLoaded,
      (err) => console.warn(`Failed to load tile normalmap: ${normalUrl}`, err)
    );
    normalTex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    normalTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    
    const flowUrl = `/assets/tiles/${z}/flow/${x}_${serverY}.png${cacheBuster}`;
    const flowTex = new BABYLON.Texture(
      flowUrl,
      this.scene,
      true,
      true, // invertY must be true to match Babylon texture coordinate mapping
      BABYLON.Texture.LINEAR_LINEAR,
      checkLoaded,
      (err) => console.warn(`Failed to load tile flowmap: ${flowUrl}`, err)
    );
    flowTex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    flowTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    
    let prevTex = this.coarseHeightTex;
    let parentScale = 0.0;
    let parentOffsetX = 0.0;
    let parentOffsetY = 0.0;
    
    // Perfect geomorphing: use the active parent tile's heightmap as the previous morph state
    if (z > 0 && z > this.currentZoom) {
      const pZ = z - 1;
      const pX = Math.floor(x / 2);
      const pY = Math.floor(y / 2);
      const parentKey = `${pZ}_${pX}_${pY}`;
      if (this.activeTiles.has(parentKey)) {
        const parentTile = this.activeTiles.get(parentKey);
        if (parentTile.heightTex && parentTile.loaded) {
          prevTex = parentTile.heightTex;
          parentScale = 0.5;
          parentOffsetX = (x % 2) * 0.5;
          parentOffsetY = (y % 2) * 0.5;
        }
      }
    }
    
    material.setFloat("uParentUvScale", parentScale);
    material.setVector2("uParentUvOffset", new BABYLON.Vector2(parentOffsetX, parentOffsetY));
    material.setTexture("tHeight", heightTex);
    material.setTexture("tHeightPrev", prevTex || heightTex);
    material.setTexture("tNormal", normalTex);
    material.setTexture("tFlow", flowTex);
    
    tileObj.heightTex = heightTex;
    tileObj.normalTex = normalTex;
    tileObj.flowTex = flowTex;
    
    mesh.material = material;
    
    this.activeTiles.set(key, tileObj);
  }

  buildVegetationSPS(tileObj, z, posX, posZ, tileSize, physics) {
    if (!physics) return;
    
    // Quick pass to check if there is any forest zone in this tile area to prevent empty SPS overhead
    const numTrees = z === 2 ? 80 : 200;
    let forestZoneCount = 0;
    const checkStep = tileSize / 8;
    for (let dx = -tileSize / 2; dx <= tileSize / 2; dx += checkStep) {
      for (let dz = -tileSize / 2; dz <= tileSize / 2; dz += checkStep) {
        const worldX = posX + dx;
        const worldZ = posZ + dz;
        const gridX = Math.floor((worldX + 1000.0) / 2000.0 * 256);
        const gridY = Math.floor((1000.0 - worldZ) / 2000.0 * 256);
        const idx = Math.max(0, Math.min(256 * 256 - 1, gridY * 256 + gridX));
        
        const heightVal = physics.heightmap[idx];
        const moistVal = physics.moisture[idx];
        const isWater = physics.isWater[idx];
        
        if ((heightVal > 0.08) && (heightVal < 0.45) && (moistVal > 0.28) && (isWater !== 1)) {
          forestZoneCount++;
        }
      }
    }
    
    if (forestZoneCount === 0) {
      return; // Skip SPS allocation entirely for sterile regions (ocean, sand, peaks)
    }

    const sps = new BABYLON.SolidParticleSystem(`sps_${posX}_${posZ}`, this.scene, { updatable: true });
    sps.addShape(this.treeTemplate, numTrees);
    const spsMesh = sps.buildMesh();
    spsMesh.material = this.treeTemplate.material;
    
    // Enable shadows for trees
    spsMesh.receiveShadows = true;
    if (this.scene.metadata && this.scene.metadata.shadowGenerator) {
      this.scene.metadata.shadowGenerator.addShadowCaster(spsMesh);
    }
    
    sps.initParticles = () => {
      for (let p = 0; p < sps.nbParticles; p++) {
        const particle = sps.particles[p];
        
        // Random placement inside local tile coordinates
        const localX = (Math.random() - 0.5) * tileSize;
        const localZ = (Math.random() - 0.5) * tileSize;
        
        const worldX = posX + localX;
        const worldZ = posZ + localZ;
        
        // Map world coordinates to physics grid indices
        const gridX = Math.floor((worldX + 1000.0) / 2000.0 * 256);
        const gridY = Math.floor((1000.0 - worldZ) / 2000.0 * 256);
        const idx = Math.max(0, Math.min(256 * 256 - 1, gridY * 256 + gridX));
        
        const heightVal = physics ? physics.heightmap[idx] : 0.0;
        const moistVal = physics ? physics.moisture[idx] : 0.5;
        const isWater = physics ? physics.isWater[idx] : 0;
        
        // Pinewood growth conditions: above sea level, not too high/rocky, and sufficiently moist
        const isForestZone = (heightVal > 0.08) && (heightVal < 0.45) && (moistVal > 0.28) && (isWater !== 1);
        
        if (isForestZone) {
          particle.position.set(localX, heightVal * this.uniforms.uScale - 0.15, localZ);
          
          // Add organic scale and rotation variations
          const scale = 0.55 + Math.random() * 0.9;
          particle.scale.set(scale, scale, scale);
          particle.rotation.y = Math.random() * Math.PI * 2;
          particle.rotation.x = (Math.random() - 0.5) * 0.08;
          particle.rotation.z = (Math.random() - 0.5) * 0.08;
          
          // Season color blending
          const seasonInt = this.uniforms.uSeason;
          let color = new BABYLON.Color4(0.22, 0.48, 0.12, 1.0); // green
          
          if (seasonInt === 0) {
            color = new BABYLON.Color4(0.28, 0.55, 0.15, 1.0); // Spring: bright green
          } else if (seasonInt === 2) {
            // Autumn gold/red
            color = new BABYLON.Color4(0.55 + Math.random() * 0.15, 0.35 + Math.random() * 0.1, 0.08, 1.0);
          } else if (seasonInt === 3) {
            // Winter bare/frost
            color = new BABYLON.Color4(0.48, 0.46, 0.45, 1.0);
          }
          particle.color = color;
        } else {
          // Hide particle below terrain
          particle.position.y = -9999;
        }
      }
    };
    
    sps.initParticles();
    sps.setParticles();
    
    // Hide mesh initially if tile is not enabled
    spsMesh.setEnabled(tileObj.mesh.isEnabled());
    
    tileObj.sps = sps;
    tileObj.spsMesh = spsMesh;
  }
  
  updateUniforms(activeLayer, timeOfDay, lightDir, lightColor, isZoomed, focusX, focusY, season, time) {
    this.uniforms.activeLayer = activeLayer;
    this.uniforms.timeOfDay = timeOfDay;
    this.uniforms.uLightDir.copyFrom(lightDir);
    this.uniforms.uLightColor.copyFrom(lightColor);
    this.uniforms.uTime = time;
    
    // Animate geomorph progress over 250ms (approx 15 frames)
    // 2. Animate Geomorphing
    if (this.morphStartTime) {
      const elapsed = performance.now() - this.morphStartTime;
      const progressAmount = Math.min(1.0, elapsed / 250.0); // 250ms crossfade
      
      let progress = 0.0;
      if (this.morphDirection === 1) {
        progress = progressAmount;
      } else {
        progress = 1.0 - progressAmount;
      }
      this.uniforms.uMorphProgress = progress;
      
      // Animate active tiles ONLY if zooming in. If zooming out, active tiles are the target (hidden) and stay at 1.0
      if (this.morphDirection === 1) {
        for (const tile of this.activeTiles.values()) {
          if (tile.material) tile.material.setFloat("uMorphProgress", progress);
        }
      }
      
      if (this.pendingDisposals) {
        for (const tile of this.pendingDisposals) {
          if (tile.material) tile.material.setFloat("uMorphProgress", progress);
        }
      }
      
      if (progressAmount >= 1.0) {
        this.morphStartTime = null;
        
        // Ensure uMorphProgress is permanently 1.0 for all active tiles once morph is complete
        this.uniforms.uMorphProgress = 1.0;
        for (const tile of this.activeTiles.values()) {
          if (tile.material) tile.material.setFloat("uMorphProgress", 1.0);
        }
        
        if (this.morphDirection === -1 && this.pendingEnables) {
          for (const tile of this.pendingEnables) {
            if (tile.mesh) tile.mesh.setEnabled(true);
            if (tile.spsMesh) tile.spsMesh.setEnabled(true);
          }
          this.pendingEnables = [];
        }
        
        // Detach old parent textures from active materials before disposing them to prevent WebGL black material errors
        for (const tile of this.activeTiles.values()) {
          if (tile.material && tile.heightTex) {
            tile.material.setTexture("tHeightPrev", tile.heightTex);
          }
        }
        
        if (this.pendingDisposals) {
          for (const tile of this.pendingDisposals) {
            if (tile.mesh) tile.mesh.dispose();
            if (tile.material) tile.material.dispose();
            if (tile.heightTex) tile.heightTex.dispose();
            if (tile.normalTex) tile.normalTex.dispose();
            if (tile.flowTex) tile.flowTex.dispose();
            if (tile.sps) tile.sps.dispose();
            if (tile.spsMesh) {
              if (this.scene.metadata && this.scene.metadata.shadowGenerator) {
                this.scene.metadata.shadowGenerator.removeShadowCaster(tile.spsMesh);
              }
              tile.spsMesh.dispose();
            }
          }
          this.pendingDisposals = [];
        }
      }
    }
    
    const seasonMap = {
      'spring': 0,
      'summer': 1,
      'autumn': 2,
      'winter': 3
    };
    const seasonInt = seasonMap[season] ?? 1;
    
    // Check if season changed to trigger SPS redraw
    const seasonChanged = this.uniforms.uSeason !== seasonInt;
    this.uniforms.uSeason = seasonInt;
    
    // Calculate regional weather texture viewport boundaries
    const serverWidth = 1024;
    const chunkScale = 256.0 / serverWidth;
    let fx = Math.floor(focusX * serverWidth) - 128;
    let fy = Math.floor(focusY * serverWidth) - 128;
    fx = Math.max(0, Math.min(serverWidth - 256, fx));
    fy = Math.max(0, Math.min(serverWidth - 256, fy));
    
    this.uniforms.uIsZoomed = isZoomed ? 1.0 : 0.0;
    this.uniforms.uWeatherOffset.set(fx / serverWidth, (serverWidth - 256 - fy) / serverWidth);
    this.uniforms.uWeatherScale = chunkScale;
    
    for (const tile of this.activeTiles.values()) {
      if (tile.material) {
        tile.material.setInt("activeLayer", activeLayer);
        tile.material.setFloat("timeOfDay", timeOfDay);
        tile.material.setVector3("uLightDir", lightDir);
        tile.material.setColor3("uLightColor", lightColor);
        tile.material.setFloat("uIsZoomed", this.uniforms.uIsZoomed);
        tile.material.setVector2("uWeatherOffset", this.uniforms.uWeatherOffset);
        tile.material.setFloat("uWeatherScale", this.uniforms.uWeatherScale);
        tile.material.setInt("uSeason", seasonInt);
        tile.material.setFloat("uTime", time);
        tile.material.setFloat("uMorphProgress", this.uniforms.uMorphProgress);
      }
      
      // Update instanced tree colors when the season changes
      if (seasonChanged && tile.sps && tile.sps.particles) {
        tile.sps.initParticles();
        tile.sps.setParticles();
      }
    }
  }
  
  updateWeatherTexture(physics) {
    const data = new Float32Array(this.terrainWidth * this.terrainHeight * 4);
    
    for (let i = 0; i < physics.size; i++) {
      const row = Math.floor(i / this.terrainWidth);
      const col = i % this.terrainWidth;
      // Perform manual vertical flip on JS side to avoid deprecated WebGL driver y-flips on raw buffer uploads
      const targetIdx = ((this.terrainHeight - 1 - row) * this.terrainWidth + col) * 4;
      
      data[targetIdx] = (physics.temperature[i] + 20.0) / 70.0;
      data[targetIdx + 1] = physics.moisture[i];
      data[targetIdx + 2] = physics.rain[i];
      data[targetIdx + 3] = physics.snow[i];
    }
    
    if (this.weatherTex) {
      this.weatherTex.update(data);
    }
  }
  
  // Load coarse heightmap texture for geomorphing background references
  loadCoarseTextures() {
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    const cacheBuster = `?v=2`;
    const coarseUrl = `/assets/tiles/0/height/0_0.png${cacheBuster}`;
    this.coarseHeightTex = new BABYLON.Texture(
      coarseUrl,
      this.scene,
      true,
      true, // invertY matches coordinates mapping
      BABYLON.Texture.LINEAR_LINEAR,
      () => {
        console.log("[Terrain] Coarse heightmap texture loaded for geomorphing.");
      },
      (err) => console.warn(`Failed to load coarse heightmap: ${coarseUrl}`, err)
    );
    this.coarseHeightTex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    this.coarseHeightTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
  }
}
