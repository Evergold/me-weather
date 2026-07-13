// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.material = null;
    
    this.heightmapTex = null;
    this.heightmapTexPrev = null;
    this.normalmapTex = null;
    this.weatherTex = null;
    
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    this.size = this.terrainWidth * this.terrainHeight;
    
    // Geomorphing state
    this.morphProgress = 1.0;
    
    this.initShaders();
    this.initMesh();
    this.initMaterial();
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

      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vUv = uv;
        
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
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float vHeight;

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 lightDir = normalize(-uLightDir);
        float diffuse = max(0.12, dot(normal, lightDir));

        vec4 wData = texture2D(tWeather, vUv);
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
  
  initMesh() {
    this.mesh = BABYLON.MeshBuilder.CreateGround(
      "terrain",
      { width: 2000, height: 2000, subdivisions: 255 },
      this.scene
    );
    this.mesh.receiveShadows = true;
  }
  
  initMaterial() {
    this.material = new BABYLON.ShaderMaterial(
      "weatherTerrainMaterial",
      this.scene,
      {
        vertex: "weatherTerrain",
        fragment: "weatherTerrain",
      },
      {
        attributes: ["position", "uv"],
        uniforms: ["world", "view", "projection", "worldViewProjection", "uScale", "uMorphProgress", "activeLayer", "timeOfDay", "uLightDir", "uLightColor"],
        samplers: ["tHeight", "tHeightPrev", "tNormal", "tWeather"]
      }
    );
    
    this.material.setFloat("uScale", 250.0);
    this.material.setFloat("uMorphProgress", 1.0);
    this.material.setInt("activeLayer", 0);
    this.material.setFloat("timeOfDay", 480.0);
    this.material.setVector3("uLightDir", new BABYLON.Vector3(-0.5, -0.8, -0.5));
    this.material.setColor3("uLightColor", new BABYLON.Color3(1.0, 1.0, 1.0));

    this.mesh.material = this.material;

    // Initialize an empty weather texture to update in-place later (prevents WebGPU validation/destroyed texture errors)
    const defaultData = new Float32Array(this.terrainWidth * this.terrainHeight * 4);
    this.weatherTex = new BABYLON.RawTexture(
      defaultData,
      this.terrainWidth,
      this.terrainHeight,
      BABYLON.Engine.TEXTUREFORMAT_RGBA,
      this.scene,
      false,
      false, // Set to false to avoid WebGL/WebGPU driver-side y-flip deprecations
      BABYLON.Texture.NEAREST_SAMPLINGMODE,
      BABYLON.Engine.TEXTURETYPE_FLOAT
    );
    this.material.setTexture("tWeather", this.weatherTex);
  }
  
  loadCoarseTextures() {
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    
    this.heightmapTex = new BABYLON.Texture(
      `${apiProtocol}//${apiHost}/assets/heightmap_coarse.png`,
      this.scene,
      true,
      true, // invertY to match standard ground UV mapping
      BABYLON.Texture.LINEAR_LINEAR
    );
    this.heightmapTexPrev = this.heightmapTex;
    
    this.material.setTexture("tHeight", this.heightmapTex);
    this.material.setTexture("tHeightPrev", this.heightmapTexPrev);
    
    this.normalmapTex = new BABYLON.Texture(
      `${apiProtocol}//${apiHost}/assets/normalmap_coarse.jpg`,
      this.scene,
      true,
      true, // invertY to match standard ground UV mapping
      BABYLON.Texture.LINEAR_LINEAR
    );
    this.material.setTexture("tNormal", this.normalmapTex);
  }
  
  triggerGeomorph() {
    this.morphProgress = 0.0;
    this.material.setFloat("uMorphProgress", 0.0);
    
    const animateMorph = () => {
      this.morphProgress += 1.0 / 15.0; // 15-frame window
      if (this.morphProgress >= 1.0) {
        this.morphProgress = 1.0;
        this.material.setFloat("uMorphProgress", 1.0);
        this.heightmapTexPrev = this.heightmapTex;
        this.material.setTexture("tHeightPrev", this.heightmapTexPrev);
      } else {
        this.material.setFloat("uMorphProgress", this.morphProgress);
        requestAnimationFrame(animateMorph);
      }
    };
    requestAnimationFrame(animateMorph);
  }
  
  updateHeightmap(newTexture) {
    this.heightmapTexPrev = this.heightmapTex;
    this.material.setTexture("tHeightPrev", this.heightmapTexPrev);
    
    this.heightmapTex = newTexture;
    this.material.setTexture("tHeight", this.heightmapTex);
    
    this.triggerGeomorph();
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
}
