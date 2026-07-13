// particles.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';

export class WeatherParticles {
  constructor(scene) {
    this.scene = scene;
    this.rainSystem = null;
    this.snowSystem = null;
    this.cloudSystem = null;
    
    this.initRain();
    this.initSnow();
    this.initClouds();
  }
  
  createParticleSystem(name, capacity) {
    const isWebGPU = this.scene.getEngine().isWebGPU;
    if (isWebGPU) {
      try {
        console.log(`[Particles] Creating GPUParticleSystem for ${name} (capacity: ${capacity})`);
        return new BABYLON.GPUParticleSystem(name, { capacity: capacity }, this.scene);
      } catch (e) {
        console.warn(`[Particles] Failed to create GPUParticleSystem for ${name}, falling back to CPU ParticleSystem:`, e);
      }
    }
    console.log(`[Particles] Creating CPU ParticleSystem for ${name} (capacity: ${capacity})`);
    return new BABYLON.ParticleSystem(name, capacity, this.scene);
  }

  initRain() {
    this.rainSystem = this.createParticleSystem("rain", 4000);
    this.rainSystem.particleTexture = new BABYLON.Texture("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", this.scene);
    this.rainSystem.emitter = new BABYLON.Vector3(0, 400, 0);
    this.rainSystem.minEmitBox = new BABYLON.Vector3(-1000, 0, -1000);
    this.rainSystem.maxEmitBox = new BABYLON.Vector3(1000, 0, 1000);
    
    this.rainSystem.color1 = new BABYLON.Color4(0.4, 0.55, 0.8, 0.7);
    this.rainSystem.color2 = new BABYLON.Color4(0.4, 0.55, 0.8, 0.7);
    this.rainSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    
    this.rainSystem.minSize = 1.0;
    this.rainSystem.maxSize = 2.0;
    this.rainSystem.minLifeTime = 1.0;
    this.rainSystem.maxLifeTime = 2.0;
    this.rainSystem.emitRate = 0;
    
    this.rainSystem.gravity = new BABYLON.Vector3(0, -900, 0);
    this.rainSystem.direction1 = new BABYLON.Vector3(0, -1, 0);
    this.rainSystem.direction2 = new BABYLON.Vector3(0, -1, 0);
    this.rainSystem.minSpeed = 5;
    this.rainSystem.maxSpeed = 10;
    
    this.rainSystem.start();
  }
  
  initSnow() {
    this.snowSystem = this.createParticleSystem("snow", 4000);
    this.snowSystem.particleTexture = new BABYLON.Texture("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", this.scene);
    this.snowSystem.emitter = new BABYLON.Vector3(0, 400, 0);
    this.snowSystem.minEmitBox = new BABYLON.Vector3(-1000, 0, -1000);
    this.snowSystem.maxEmitBox = new BABYLON.Vector3(1000, 0, 1000);
    
    this.snowSystem.color1 = new BABYLON.Color4(1.0, 1.0, 1.0, 0.9);
    this.snowSystem.color2 = new BABYLON.Color4(1.0, 1.0, 1.0, 0.9);
    this.snowSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    
    this.snowSystem.minSize = 2.0;
    this.snowSystem.maxSize = 4.0;
    this.snowSystem.minLifeTime = 3.0;
    this.snowSystem.maxLifeTime = 5.0;
    this.snowSystem.emitRate = 0;
    
    this.snowSystem.gravity = new BABYLON.Vector3(0, -150, 0);
    this.snowSystem.direction1 = new BABYLON.Vector3(-1, -1, -1);
    this.snowSystem.direction2 = new BABYLON.Vector3(1, -1, 1);
    this.snowSystem.minSpeed = 1;
    this.snowSystem.maxSpeed = 3;
    
    this.snowSystem.start();
  }
  
  initClouds() {
    this.cloudSystem = this.createParticleSystem("clouds", 6000);
    this.cloudSystem.particleTexture = new BABYLON.Texture("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", this.scene);
    this.cloudSystem.emitter = new BABYLON.Vector3(0, 200, 0);
    this.cloudSystem.minEmitBox = new BABYLON.Vector3(-1000, -20, -1000);
    this.cloudSystem.maxEmitBox = new BABYLON.Vector3(1000, 20, 1000);
    
    this.cloudSystem.color1 = new BABYLON.Color4(0.8, 0.85, 0.9, 0.35);
    this.cloudSystem.color2 = new BABYLON.Color4(0.8, 0.85, 0.9, 0.35);
    this.cloudSystem.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    
    this.cloudSystem.minSize = 40.0;
    this.cloudSystem.maxSize = 80.0;
    this.cloudSystem.minLifeTime = 20.0;
    this.cloudSystem.maxLifeTime = 30.0;
    this.cloudSystem.emitRate = 0;
    
    this.cloudSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    this.cloudSystem.gravity = new BABYLON.Vector3(0, 0, 0);
    
    this.cloudSystem.start();
  }
  
  update(physics, toggleWeather, activeLayer, windSpeed, windAngle) {
    const rad = (windAngle * Math.PI) / 180.0;
    const wx = Math.sin(rad) * windSpeed * 2.0;
    const wz = -Math.cos(rad) * windSpeed * 2.0;
    
    this.rainSystem.direction1 = new BABYLON.Vector3(wx * 0.1, -1, wz * 0.1);
    this.rainSystem.direction2 = new BABYLON.Vector3(wx * 0.2, -1, wz * 0.2);
    
    this.snowSystem.direction1 = new BABYLON.Vector3(-1 + wx * 0.15, -1, -1 + wz * 0.15);
    this.snowSystem.direction2 = new BABYLON.Vector3(1 + wx * 0.2, -1, 1 + wz * 0.2);
    
    if (toggleWeather) {
      let rainSum = 0;
      let snowSum = 0;
      const count = Math.min(1000, physics.size);
      const stride = Math.max(1, Math.floor(physics.size / count));
      for (let i = 0; i < physics.size; i += stride) {
        rainSum += physics.rain[i];
        snowSum += physics.snow[i];
      }
      const avgRain = rainSum / (physics.size / stride);
      const avgSnow = snowSum / (physics.size / stride);
      
      this.rainSystem.emitRate = avgRain > 0.05 ? avgRain * 1500 : 0;
      this.snowSystem.emitRate = avgSnow > 0.05 ? avgSnow * 1500 : 0;
    } else {
      this.rainSystem.emitRate = 0;
      this.snowSystem.emitRate = 0;
    }
    
    if (activeLayer === 'moisture') {
      this.cloudSystem.emitRate = 350;
      this.cloudSystem.minEmitBox.x += wx * 0.01;
      this.cloudSystem.maxEmitBox.x += wx * 0.01;
      this.cloudSystem.minEmitBox.z += wz * 0.01;
      this.cloudSystem.maxEmitBox.z += wz * 0.01;
      
      if (Math.abs(this.cloudSystem.minEmitBox.x) > 2000) {
        this.cloudSystem.minEmitBox.x = -1000;
        this.cloudSystem.maxEmitBox.x = 1000;
        this.cloudSystem.minEmitBox.z = -1000;
        this.cloudSystem.maxEmitBox.z = 1000;
      }
    } else {
      this.cloudSystem.emitRate = 0;
    }
  }

  triggerLightning(startX, startZ) {
    const points = [];
    const current = new BABYLON.Vector3(startX, 400, startZ);
    points.push(current.clone());

    const segments = 12;
    for (let i = 0; i < segments; i++) {
      const step = 400 / segments;
      const deviation = 28;
      current.y -= step;
      current.x += (Math.random() * 2 - 1) * deviation;
      current.z += (Math.random() * 2 - 1) * deviation;
      points.push(current.clone());
    }

    const lines = BABYLON.MeshBuilder.CreateLines("lightning_bolt", { points: points }, this.scene);
    lines.color = new BABYLON.Color3(0.85, 0.95, 1.0);
    
    let glow = 1.0;
    const flashInterval = setInterval(() => {
      glow -= 0.15;
      if (glow <= 0) {
        lines.dispose();
        clearInterval(flashInterval);
      } else {
        lines.visibility = glow;
      }
    }, 40);
  }
}
