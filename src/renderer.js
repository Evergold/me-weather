// renderer.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as BABYLON from '@babylonjs/core';
import '@babylonjs/loaders';
import { WeatherTerrain } from './terrain.js';
import { WeatherParticles } from './particles.js';
import { WeatherAcoustics } from './acoustics.js';

export class WeatherRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.engine = null;
    this.scene = null;
    this.camera = null;
    
    this.ambientLight = null;
    this.sunLight = null;
    this.shadowGenerator = null;
    
    this.terrain = null;
    this.particles = null;
    this.acoustics = null;
    
    this.isOverhead = false;
    this.isTerrainLoaded = false;
    this.markers = [];
    
    // Pacing variable for shadow updates
    this.lastSunAngle = -999.0;
    this.tickCount = 0;
    
    this.initEngine();
  }
  
  async initEngine() {
    const options = {
      powerPreference: "default",
      failIfMajorPerformanceCaveat: false,
      useHighPrecisionFloats: true
    };
    
    // 1. Initialise WebGPUEngine (WebGPU preferred, fallback to WebGL 2)
    const webgpuSupported = await BABYLON.WebGPUEngine.IsSupportedAsync;
    
    if (webgpuSupported) {
      console.log("[Client Renderer] WebGPU supported. Initializing WebGPUEngine...");
      this.engine = new BABYLON.WebGPUEngine(this.canvas, {
        ...options,
        antialias: true
      });
      await this.engine.initAsync();
    } else {
      console.warn("[Client Renderer] WebGPU not supported. Falling back to WebGL 2...");
      this.engine = new BABYLON.Engine(this.canvas, true, options);
      this.showWebGLFallbackBanner();
    }
    
    // 2. Setup Scene & Fog
    this.scene = new BABYLON.Scene(this.engine);
    this.scene.clearColor = new BABYLON.Color4(0.06, 0.07, 0.08, 1.0); // Sleek dark theme
    this.scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    this.scene.fogColor = new BABYLON.Color3(0.06, 0.07, 0.08);
    this.scene.fogDensity = 0.0015;
    
    // 3. Setup ArcRotateCamera
    this.camera = new BABYLON.ArcRotateCamera(
      "MainCamera",
      -Math.PI / 2,
      Math.PI / 3,
      1200,
      new BABYLON.Vector3(0, 0, 0),
      this.scene
    );
    this.camera.attachControl(this.canvas, true);
    this.camera.lowerBetaLimit = 0.01;
    this.camera.upperBetaLimit = Math.PI / 2.1; // Prevent going below ground
    this.camera.lowerRadiusLimit = 20;
    this.camera.upperRadiusLimit = 3000;
    
    // 4. Setup Lights & Adaptive CSM
    this.initLights();
    
    // 5. Setup Sub-systems
    this.terrain = new WeatherTerrain(this.scene);
    this.particles = new WeatherParticles(this.scene);
    
    this.acoustics = new WeatherAcoustics();
    this.acoustics.init();
    
    // Load heightmaps
    this.terrain.loadCoarseTextures();
    this.isTerrainLoaded = true;
    
    // Listen for window resize
    window.addEventListener('resize', () => {
      this.engine.resize();
    });
  }

  showWebGLFallbackBanner() {
    if (document.getElementById('webgl-fallback-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'webgl-fallback-banner';
    banner.className = 'warning-banner';
    banner.innerHTML = `
      <span class="banner-icon">⚠️</span>
      <span class="banner-text">Running in WebGL 2 Fallback Mode: High-fidelity GPU-only displacement is disabled on this device.</span>
    `;
    document.body.appendChild(banner);
  }

  initLights() {
    // Ambient Light
    this.ambientLight = new BABYLON.HemisphericLight("ambient", new BABYLON.Vector3(0, 1, 0), this.scene);
    this.ambientLight.intensity = 0.6;
    this.ambientLight.diffuse = new BABYLON.Color3(0.16, 0.18, 0.24);

    // Directional Sunlight Source
    this.sunLight = new BABYLON.DirectionalLight("sunLight", new BABYLON.Vector3(-0.5, -0.8, -0.5), this.scene);
    this.sunLight.intensity = 1.2;
    this.sunLight.diffuse = new BABYLON.Color3(1.0, 0.95, 0.88);

    // Profile detection (Desktop vs. Mobile)
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const shadowSize = isMobile ? 1024 : 2048;

    this.shadowGenerator = new BABYLON.ShadowGenerator(shadowSize, this.sunLight);
    this.shadowGenerator.usePercentageCloserFiltering = true;
    this.shadowGenerator.filteringQuality = isMobile ? BABYLON.ShadowGenerator.QUALITY_LOW : BABYLON.ShadowGenerator.QUALITY_HIGH;
    
    this.sunLight.shadowMinZ = 0.5;
    this.sunLight.shadowMaxZ = 4000;
  }
  
  draw(physics, activeLayer, toggleWind, toggleWeather, toggleLandmarks, landmarks, selectedLandmarkId, timeOfDay) {
    if (!this.scene) return;
    
    this.tickCount++;

    // 1. Calculate Sun Direction & Colors based on timeOfDay (minutes past midnight)
    const hour = timeOfDay / 60.0;
    const angle = (hour - 6.0) * Math.PI / 12.0; // sun orbit angle
    const lightDir = new BABYLON.Vector3();
    const lightColor = new BABYLON.Color3();
    
    if (hour >= 6.0 && hour <= 18.0) {
      // Day
      const sinAngle = Math.sin(angle);
      const cosAngle = Math.cos(angle);
      lightDir.set(-cosAngle, -sinAngle, -0.3).normalize();
      
      const sunriseFactor = Math.max(0, 1 - Math.abs(hour - 6.5) * 1.5);
      const sunsetFactor = Math.max(0, 1 - Math.abs(hour - 17.5) * 1.5);
      const goldenHour = Math.max(sunriseFactor, sunsetFactor);
      
      lightColor.setRGB(1.0, 0.95, 0.88);
      if (goldenHour > 0) {
        // blend to golden orange
        lightColor.r = lightColor.r * (1 - goldenHour) + 1.0 * goldenHour;
        lightColor.g = lightColor.g * (1 - goldenHour) + 0.58 * goldenHour;
        lightColor.b = lightColor.b * (1 - goldenHour) + 0.15 * goldenHour;
      }
      
      this.sunLight.direction.copyFrom(lightDir);
      this.sunLight.intensity = 1.6 * sinAngle;
      this.sunLight.diffuse.copyFrom(lightColor);
    } else {
      // Night
      const moonAngle = (hour + 6.0) * Math.PI / 12.0;
      const sinMoon = Math.sin(moonAngle);
      const cosMoon = Math.cos(moonAngle);
      lightDir.set(-cosMoon, -sinMoon, -0.3).normalize();
      lightColor.setRGB(0.12, 0.18, 0.32); // Cool moonlight
      
      this.sunLight.direction.copyFrom(lightDir);
      this.sunLight.intensity = 0.35;
      this.sunLight.diffuse.copyFrom(lightColor);
    }
    
    // 2. Shadow Update Frequency Pacing (Feature optimization)
    // Only update shadow generator matrices if sun moves by >= 0.2 degrees or once every 5 ticks
    const currentAngle = angle * 180.0 / Math.PI;
    if (Math.abs(currentAngle - this.lastSunAngle) >= 0.2 || this.tickCount % 5 === 0) {
      this.shadowGenerator.getShadowMap().refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      this.lastSunAngle = currentAngle;
    }
    
    // 3. Upload dynamic weather data textures
    this.terrain.updateWeatherTexture(physics);
    
    // 4. Update weather particles
    this.particles.update(physics, toggleWeather, activeLayer, physics.getWeatherAt(0.5, 0.5).windSpeed, physics.getWeatherAt(0.5, 0.5).windAngle);
    
    // 5. Update acoustics
    const stats = physics.getWeatherAt(0.5, 0.5);
    this.acoustics.update(stats.windSpeed, stats.moisture, stats.rain);
    
    // 6. Draw Landmarks markers
    this.drawLandmarks(landmarks, selectedLandmarkId, toggleLandmarks, physics);
    
    // 7. Push camera location/zoom telemetry to server for active viewport chunk loading
    this.updateCameraTelemetry(physics);
    
    // 8. Render frame
    this.scene.render();
  }
  
  updateCameraTelemetry(physics) {
    if (!this.camera) return;
    
    const isZoomed = this.camera.radius < 500;
    const fx = Math.max(0, Math.min(1, (this.camera.target.x + 1000) / 2000));
    const fy = Math.max(0, Math.min(1, (1000 - this.camera.target.z) / 2000));
    
    const distSq = (fx - physics.focusX) * (fx - physics.focusX) + (fy - physics.focusY) * (fy - physics.focusY);
    
    if (isZoomed !== physics.zoomedIn || distSq > 0.002) {
      physics.sendSettings({
        zoomed_in: isZoomed,
        focus_x: fx,
        focus_y: fy
      });
    }
  }
  
  drawLandmarks(landmarks, selectedId, visible, physics) {
    // Clear old markers meshes
    this.markers.forEach(m => m.dispose());
    this.markers = [];
    
    if (!visible) return;
    
    landmarks.forEach(lm => {
      // Map normalized coordinates [0, 1] to world space [-1000, 1000]
      const wx = lm.x * 2000 - 1000;
      const wz = (1.0 - lm.y) * 2000 - 1000;
      
      const weather = physics.getWeatherAt(lm.x, lm.y);
      const wy = (weather.altitude / 3800 * 250.0) + 12.0;
      
      const isSelected = lm.id === selectedId;
      
      // Draw Cone pin
      const cone = BABYLON.MeshBuilder.CreateCone(
        "landmark_cone_" + lm.id,
        { height: 18, diameterTop: 0, diameterBottom: 10 },
        this.scene
      );
      cone.position.set(wx, wy + 10, wz);
      
      const coneMat = new BABYLON.StandardMaterial("landmarkConeMat_" + lm.id, this.scene);
      coneMat.diffuseColor = isSelected ? new BABYLON.Color3(1, 0.84, 0) : (lm.isPreset ? new BABYLON.Color3(0.8, 0.67, 0.27) : new BABYLON.Color3(0, 1, 0.53));
      coneMat.specularColor = new BABYLON.Color3(0, 0, 0);
      coneMat.emissiveColor = coneMat.diffuseColor.scale(0.3);
      cone.material = coneMat;
      
      this.markers.push(cone);
      
      // Ring marker on ground
      const ring = BABYLON.MeshBuilder.CreateTorus(
        "landmark_ring_" + lm.id,
        { diameter: 18, thickness: 1 },
        this.scene
      );
      ring.position.set(wx, wy - 10, wz);
      
      const ringMat = new BABYLON.StandardMaterial("landmarkRingMat_" + lm.id, this.scene);
      ringMat.diffuseColor = isSelected ? new BABYLON.Color3(1, 0.84, 0) : new BABYLON.Color3(0.67, 0.53, 0.2);
      ring.material = ringMat;
      
      this.markers.push(ring);
    });
  }
  
  toggleOverheadView(enable) {
    this.isOverhead = enable;
    if (!this.camera) return;
    
    if (enable) {
      // Top down camera locks rotation
      this.camera.alpha = -Math.PI / 2;
      this.camera.beta = 0.01; // directly overhead
      this.camera.radius = 1600;
      this.camera.target.set(0, 0, 0);
    } else {
      this.camera.alpha = -Math.PI / 2;
      this.camera.beta = Math.PI / 3;
      this.camera.radius = 1200;
      this.camera.target.set(0, 0, 0);
    }
  }
  
  cacheTerrain(image) {
    // Stub
  }
}
