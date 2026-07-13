// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.activeTiles = new Map(); // Key: "z_x_y" -> Value: { mesh, material, heightTex, normalTex, flowTex, sps, spsMesh, loaded }
    
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    
    this.currentZoom = 0;
    
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

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vUv = uv;
        // Calculate global UV coordinates relative to the full terrain grid
        vUvGlobal.x = uTileOffset.x * uTileScale + uv.x * uTileScale;
        float tilesCount = 1.0 / uTileScale;
        vUvGlobal.y = ((tilesCount - 1.0 - uTileOffset.y) + uv.y) * uTileScale;
        
        // GPU-based Geomorphing (lerps height from prev to target to prevent LOD pops)
        float hTarget = texture2D(tHeight, uv).r;
        float hPrev = texture2D(tHeightPrev, uv).r;
        float height = mix(hPrev, hTarget, uMorphProgress);
        vHeight = height;
        
        vec3 pos = position;
        pos.y = height * uScale;
        
        vec4 worldPos = world * vec4(pos, 1.0);
        vPosition = worldPos.xyz;
        
        vec3 n = texture2D(tNormal, uv).rgb * 2.0 - 1.0;
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

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vec3 normal = normalize(vNormal);
        
        // Sample static hydrology flowmap: R/G are X/Y slope directions, B is flow accumulation (riverbed width)
        vec3 flowData = texture2D(tFlow, vUv).rgb;
        vec2 flowDir = normalize(flowData.rg * 2.0 - 1.0 + 1e-5);
        float flowStrength = flowData.b;
        
        // Rivers are carved where flow accumulation is high (Blue channel > 0.15)
        bool isWaterBody = (vHeight < 0.08) || (activeLayer == 0 && flowStrength > 0.15 && vHeight < 0.22);
        
        if (isWaterBody) {
          // Flow speed scales with river width
          float speedMultiplier = max(0.2, flowStrength * 1.5);
          float progress1 = fract(uTime * 0.08 * speedMultiplier);
          float progress2 = fract(uTime * 0.08 * speedMultiplier + 0.5);
          
          vec2 uvOffset1 = flowDir * progress1 * 0.08;
          vec2 uvOffset2 = flowDir * progress2 * 0.08;
          
          // Valve-style flowmap normal blending to prevent stretch artifacts
          vec3 n1 = texture2D(tNormal, vUv - uvOffset1).rgb * 2.0 - 1.0;
          vec3 n2 = texture2D(tNormal, vUv - uvOffset2).rgb * 2.0 - 1.0;
          
          float blend = abs(0.5 - progress1) / 0.5;
          vec3 normalPerturb = normalize(mix(n1, n2, blend));
          normal = normalize(normal + normalPerturb * 0.35);
        }

        vec3 lightDir = normalize(-uLightDir);
        float diffuse = max(0.12, dot(normal, lightDir));

        // Sample weather data using global UV coordinates across the entire Middle-earth grid,
        // adjusting if focused on a high-resolution regional chunk.
        vec2 weatherUv = vUvGlobal;
        if (uIsZoomed > 0.5) {
          weatherUv = (vUvGlobal - uWeatherOffset) / uWeatherScale;
        }
        vec4 wData = texture2D(tWeather, clamp(weatherUv, 0.0, 1.0));
        
        float temp = wData.r * 70.0 - 20.0;
        float moist = wData.g;
        float rain = wData.b;
        float snow = wData.a;

        vec3 baseColor = vec3(0.3, 0.45, 0.2);

        if (activeLayer == 0 || activeLayer == 2) {
          if (vHeight < 0.08) {
            baseColor = vec3(0.08, 0.18, 0.36); // Ocean
          } else if (isWaterBody) {
            // Billow Beer's Law style shading for river depth
            baseColor = mix(vec3(0.15, 0.32, 0.52), vec3(0.08, 0.18, 0.32), clamp((vHeight - 0.08) * 4.0, 0.0, 1.0));
          } else if (vHeight < 0.12) {
            baseColor = vec3(0.85, 0.82, 0.65); // Sand
          } else if (vHeight > 0.6) {
            baseColor = vec3(0.95, 0.95, 0.95); // Snow peaks
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
    // Procedural Low-poly Pine Tree Template
    const trunk = BABYLON.MeshBuilder.CreateCylinder("trunk", { height: 1.0, diameterTop: 0.15, diameterBottom: 0.25, tessellation: 4 }, this.scene);
    trunk.position.y = 0.5;
    
    const trunkColors = [];
    for (let i = 0; i < trunk.getTotalVertices(); i++) {
      trunkColors.push(0.38, 0.26, 0.16, 1.0); // Brown
    }
    trunk.setVerticesData(BABYLON.VertexBuffer.ColorKind, trunkColors);

    const foliage = BABYLON.MeshBuilder.CreateCylinder("foliage", { height: 2.2, diameterTop: 0.0, diameterBottom: 1.2, tessellation: 5 }, this.scene);
    foliage.position.y = 2.1;
    
    const foliageColors = [];
    for (let i = 0; i < foliage.getTotalVertices(); i++) {
      foliageColors.push(0.22, 0.48, 0.12, 1.0); // Forest Green
    }
    foliage.setVerticesData(BABYLON.VertexBuffer.ColorKind, foliageColors);

    this.treeTemplate = BABYLON.Mesh.MergeMeshes([trunk, foliage], true, true, undefined, false, true);
    this.treeTemplate.setEnabled(false);
    
    const treeMat = new BABYLON.StandardMaterial("treeMat", this.scene);
    treeMat.useVertexColors = true;
    treeMat.roughness = 0.85;
    this.treeTemplate.material = treeMat;
  }
  
  updateTiles(camera, physics) {
    if (!camera) return;
    
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
    
    // Determine visibility horizon based on zoom focus area
    let visibilityRadius = 3000.0; // zoom 0 sees the whole continent
    if (z === 1) visibilityRadius = 1600.0;
    if (z === 2) visibilityRadius = 900.0;
    if (z === 3) visibilityRadius = 500.0;
    
    const targetX = camera.target.x;
    const targetZ = camera.target.z;
    const visibleKeys = new Set();
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    
    // Find all tiles inside the visibility radius at target zoom z
    for (let x = 0; x < tilesCount; x++) {
      for (let y = 0; y < tilesCount; y++) {
        const tileCenterX = -1000.0 + (x + 0.5) * tileSize;
        const tileCenterZ = -1000.0 + (y + 0.5) * tileSize;
        
        const dx = tileCenterX - targetX;
        const dz = tileCenterZ - targetZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist <= visibilityRadius) {
          const key = `${z}_${x}_${y}`;
          visibleKeys.add(key);
        }
      }
    }
    
    // Create new tiles for target zoom z if they don't exist yet
    let allTargetTilesLoaded = true;
    for (const key of visibleKeys) {
      if (!this.activeTiles.has(key)) {
        const parts = key.split("_");
        const tx = parseInt(parts[1]);
        const ty = parseInt(parts[2]);
        this.createTile(z, tx, ty, tileSize, apiProtocol, apiHost, physics);
      }
      
      const tile = this.activeTiles.get(key);
      if (tile && !tile.loaded) {
        allTargetTilesLoaded = false;
      }
    }
    
    // Only perform the transition swap when all target zoom meshes are fully loaded.
    if (allTargetTilesLoaded) {
      // 1. Enable new target tiles
      for (const key of visibleKeys) {
        const tile = this.activeTiles.get(key);
        if (tile && tile.mesh) {
          tile.mesh.setEnabled(true);
          if (tile.spsMesh) {
            tile.spsMesh.setEnabled(true);
          }
        }
      }
      
      // 2. Safely dispose of old tiles from other zoom levels or out-of-bounds areas
      for (const [key, tile] of this.activeTiles.entries()) {
        const parts = key.split("_");
        const tileZ = parseInt(parts[0]);
        
        if (tileZ !== z || !visibleKeys.has(key)) {
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
          this.activeTiles.delete(key);
        }
      }
      
      this.currentZoom = z;
    }
  }
  
  createTile(z, x, y, tileSize, apiProtocol, apiHost, physics) {
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
          "uSeason", "uTime"
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
    
    // Bind tile-specific mapping offsets
    const tilesCount = Math.pow(2, z);
    material.setVector2("uTileOffset", new BABYLON.Vector2(x, y));
    material.setFloat("uTileScale", 1.0 / tilesCount);
    
    if (this.weatherTex) {
      material.setTexture("tWeather", this.weatherTex);
    }
    
    // Hide mesh until texture content is fully ready to prevent pops
    mesh.setEnabled(false);
    
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
      }
    };
    
    const heightUrl = `${apiProtocol}//${apiHost}/tiles/${z}/height/${x}_${y}.png`;
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
    
    const normalUrl = `${apiProtocol}//${apiHost}/tiles/${z}/normal/${x}_${y}.png`;
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
    
    const flowUrl = `${apiProtocol}//${apiHost}/tiles/${z}/flow/${x}_${y}.png`;
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
    
    material.setTexture("tHeight", heightTex);
    material.setTexture("tHeightPrev", heightTex);
    material.setTexture("tNormal", normalTex);
    material.setTexture("tFlow", flowTex);
    
    tileObj.heightTex = heightTex;
    tileObj.normalTex = normalTex;
    tileObj.flowTex = flowTex;
    
    mesh.material = material;
    
    this.activeTiles.set(key, tileObj);
  }

  buildVegetationSPS(tileObj, z, posX, posZ, tileSize, physics) {
    const sps = new BABYLON.SolidParticleSystem(`sps_${posX}_${posZ}`, this.scene, { updatable: true });
    // Spawn more trees for closer zoom level
    const numTrees = z === 2 ? 80 : 200;
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
  
  // Stub for backwards-compatibility or manual switches
  loadCoarseTextures() {}
}
