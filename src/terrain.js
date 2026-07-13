// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.activeTiles = new Map(); // Key: "z_x_y" -> Value: { mesh, material, heightTex, normalTex }
    
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    
    // Cache for material uniform values to apply to newly created tiles
    this.uniforms = {
      uScale: 250.0,
      uMorphProgress: 1.0,
      activeLayer: 0,
      timeOfDay: 480.0,
      uLightDir: new BABYLON.Vector3(-0.5, -0.8, -0.5),
      uLightColor: new BABYLON.Color3(1.0, 1.0, 1.0)
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

      varying vec2 vUv;
      varying vec2 vUvGlobal;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 lightDir = normalize(-uLightDir);
        float diffuse = max(0.12, dot(normal, lightDir));

        // Sample weather data using global UV coordinates across the entire Middle-earth grid
        vec4 wData = texture2D(tWeather, vUvGlobal);
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
    
    // Find all tiles inside the visibility radius
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
          
          if (!this.activeTiles.has(key)) {
            this.createTile(z, x, y, tileSize, apiProtocol, apiHost);
          }
        }
      }
    }
    
    // Remove out-of-range tiles and release resources immediately to prevent VRAM memory leaks
    for (const [key, tile] of this.activeTiles.entries()) {
      if (!visibleKeys.has(key)) {
        if (tile.mesh) tile.mesh.dispose();
        if (tile.material) tile.material.dispose();
        if (tile.heightTex) tile.heightTex.dispose();
        if (tile.normalTex) tile.normalTex.dispose();
        this.activeTiles.delete(key);
      }
    }
  }
  
  createTile(z, x, y, tileSize, apiProtocol, apiHost) {
    const key = `${z}_${x}_${y}`;
    
    // High performance subdivision grid for rendering
    const subdivisions = 64;
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
          "uLightDir", "uLightColor", "uTileOffset", "uTileScale"
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
    
    // Bind tile-specific mapping offsets
    const tilesCount = Math.pow(2, z);
    material.setVector2("uTileOffset", new BABYLON.Vector2(x, y));
    material.setFloat("uTileScale", 1.0 / tilesCount);
    
    if (this.weatherTex) {
      material.setTexture("tWeather", this.weatherTex);
    }
    
    // Hide mesh until texture content is fully ready to prevent pops
    mesh.setEnabled(false);
    
    let texturesLoaded = 0;
    const checkLoaded = () => {
      texturesLoaded++;
      if (texturesLoaded === 2) {
        mesh.setEnabled(true);
      }
    };
    
    const heightUrl = `${apiProtocol}//${apiHost}/tiles/${z}/height/${x}_${y}.png`;
    const heightTex = new BABYLON.Texture(
      heightUrl,
      this.scene,
      true,
      true, // invertY: true
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
      true, // invertY: true
      BABYLON.Texture.LINEAR_LINEAR,
      checkLoaded,
      (err) => console.warn(`Failed to load tile normalmap: ${normalUrl}`, err)
    );
    normalTex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    normalTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    
    material.setTexture("tHeight", heightTex);
    material.setTexture("tHeightPrev", heightTex);
    material.setTexture("tNormal", normalTex);
    
    mesh.material = material;
    
    this.activeTiles.set(key, {
      mesh,
      material,
      heightTex,
      normalTex
    });
  }
  
  updateUniforms(activeLayer, timeOfDay, lightDir, lightColor) {
    this.uniforms.activeLayer = activeLayer;
    this.uniforms.timeOfDay = timeOfDay;
    this.uniforms.uLightDir.copyFrom(lightDir);
    this.uniforms.uLightColor.copyFrom(lightColor);
    
    for (const tile of this.activeTiles.values()) {
      if (tile.material) {
        tile.material.setInt("activeLayer", activeLayer);
        tile.material.setFloat("timeOfDay", timeOfDay);
        tile.material.setVector3("uLightDir", lightDir);
        tile.material.setColor3("uLightColor", lightColor);
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
