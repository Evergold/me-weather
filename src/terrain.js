// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.activeTiles = new Map(); // Key: "z_x_y" -> Value: { mesh, material, heightTex, normalTex, loaded }
    
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
      uWeatherScale: 1.0
    };
    
    this.weatherTex = null;
    
    this.initShaders();
    this.initWeatherTexture();
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
        vUvGlobal = uTileOffset * uTileScale + uv * uTileScale;
        
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
      uniform int activeLayer;
      uniform float timeOfDay;
      uniform vec3 uLightDir;
      uniform vec3 uLightColor;
      
      uniform vec2 uWeatherOffset;
      uniform float uWeatherScale;
      uniform float uIsZoomed;

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vec3 normal = normalize(vNormal);
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
          } else if (vHeight < 0.12) {
            baseColor = vec3(0.85, 0.82, 0.65); // Sand
          } else if (vHeight > 0.6) {
            baseColor = vec3(0.95, 0.95, 0.95); // Snow peaks
          } else if (vHeight > 0.45) {
            baseColor = vec3(0.45, 0.42, 0.38); // Rock
          } else {
            baseColor = mix(vec3(0.2, 0.4, 0.15), vec3(0.12, 0.3, 0.1), wData.g);
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
  
  updateTiles(camera) {
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
        this.createTile(z, tx, ty, tileSize, apiProtocol, apiHost);
      }
      
      const tile = this.activeTiles.get(key);
      if (tile && !tile.loaded) {
        allTargetTilesLoaded = false;
      }
    }
    
    // Only perform the transition swap when all target zoom meshes are fully loaded.
    // This prevents layout flickering and avoids disabling the floor plane under the camera target.
    if (allTargetTilesLoaded) {
      // 1. Enable new target tiles
      for (const key of visibleKeys) {
        const tile = this.activeTiles.get(key);
        if (tile && tile.mesh) {
          tile.mesh.setEnabled(true);
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
          this.activeTiles.delete(key);
        }
      }
      
      this.currentZoom = z;
    }
  }
  
  createTile(z, x, y, tileSize, apiProtocol, apiHost) {
    const key = `${z}_${x}_${y}`;
    
    // Configure subdivision grid dynamically: higher resolution when zoomed out to retain overview shape,
    // lower subdivision per tile when zoomed in close to maintain stable high frame rates.
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
          "uWeatherOffset", "uWeatherScale", "uIsZoomed"
        ],
        samplers: ["tHeight", "tHeightPrev", "tNormal", "tWeather"]
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
      loaded: false
    };
    
    let texturesLoaded = 0;
    const checkLoaded = () => {
      texturesLoaded++;
      if (texturesLoaded === 2) {
        tileObj.loaded = true;
        // If we are modifying tiles within the current active zoom level, enable immediately on load
        if (z === this.currentZoom) {
          mesh.setEnabled(true);
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
    
    material.setTexture("tHeight", heightTex);
    material.setTexture("tHeightPrev", heightTex);
    material.setTexture("tNormal", normalTex);
    
    tileObj.heightTex = heightTex;
    tileObj.normalTex = normalTex;
    
    mesh.material = material;
    
    this.activeTiles.set(key, tileObj);
  }
  
  updateUniforms(activeLayer, timeOfDay, lightDir, lightColor, isZoomed, focusX, focusY) {
    this.uniforms.activeLayer = activeLayer;
    this.uniforms.timeOfDay = timeOfDay;
    this.uniforms.uLightDir.copyFrom(lightDir);
    this.uniforms.uLightColor.copyFrom(lightColor);
    
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
