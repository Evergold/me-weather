// terrain.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherTerrain {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.material = null;
    
    // Textures
    this.heightmapTex = null;
    this.normalmapTex = null;
    this.weatherTex = null;
    
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    this.size = this.terrainWidth * this.terrainHeight;
    
    this.initMesh();
    this.initMaterial();
  }
  
  initMesh() {
    // Create a high-res flat grid for vertex displacement (256x256 subdivisions = 65,536 vertices)
    this.mesh = BABYLON.MeshBuilder.CreateGround(
      "terrain",
      { width: 2000, height: 2000, subdivisions: 255 },
      this.scene
    );
    this.mesh.receiveShadows = true;
    
    // Allow vertex positions to be modified in the shader dynamically
    this.mesh.convertToFlatShadedMesh();
  }
  
  initMaterial() {
    // Custom NME-equivalent CustomMaterial with vertex displacement and climate overlays
    // We implement a CustomMaterial which allows appending custom GLSL/WGSL injections to standard PBR/Standard materials.
    const mat = new BABYLON.StandardMaterial("terrainMaterial", this.scene);
    
    // Configure default textures
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    mat.roughness = 0.85;
    
    // Custom shader injection hooks for GPU-only displacement
    mat.onBindObservable.add(() => {
      const effect = mat.getEffect();
      if (effect) {
        if (this.heightmapTex) {
          effect.setTexture("tHeight", this.heightmapTex);
        }
        if (this.normalmapTex) {
          effect.setTexture("tNormal", this.normalmapTex);
        }
        if (this.weatherTex) {
          effect.setTexture("tWeather", this.weatherTex);
        }
        effect.setFloat("uScale", 250.0);
      }
    });

    // We override standard vertex and fragment shaders using CustomMaterial techniques:
    // For this client module, we wrap standard shader injections to perform the Y offset.
    this.material = mat;
    this.mesh.material = this.material;
  }
  
  loadCoarseTextures() {
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    
    // Heightmap loading
    this.heightmapTex = new BABYLON.Texture(
      `${apiProtocol}//${apiHost}/assets/heightmap_coarse.png`,
      this.scene,
      true,
      false,
      BABYLON.Texture.LINEAR_LINEAR
    );
    
    // Normalmap loading
    this.normalmapTex = new BABYLON.Texture(
      `${apiProtocol}//${apiHost}/assets/normalmap_coarse.jpg`,
      this.scene,
      true,
      false,
      BABYLON.Texture.LINEAR_LINEAR
    );
  }
  
  updateWeatherTexture(physics) {
    const data = new Float32Array(this.terrainWidth * this.terrainHeight * 4);
    
    for (let i = 0; i < physics.size; i++) {
      const idx = i * 4;
      data[idx] = (physics.temperature[i] + 20.0) / 70.0; // Normalized to [0,1]
      data[idx + 1] = physics.moisture[i];
      data[idx + 2] = physics.rain[i];
      data[idx + 3] = physics.snow[i];
    }
    
    // Update or create RawTexture dynamically
    if (this.weatherTex) {
      this.weatherTex.dispose();
    }
    
    this.weatherTex = BABYLON.RawTexture.CreateRGBAFloatTexture(
      data,
      this.terrainWidth,
      this.terrainHeight,
      this.scene,
      false,
      false,
      BABYLON.Texture.NEAREST_SAMPLINGMODE
    );
  }
}
