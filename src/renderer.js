// renderer.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class WeatherRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    
    // 1. Initialize Three.js WebGL Engine (WebGL 2 is universally supported, compatible with WebGPU Node/Materials)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1115); // Sleek dark theme
    this.scene.fog = new THREE.FogExp2(0x0f1115, 0.0015);

    const container = canvas.parentElement || canvas;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // Camera setup (Perspective)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    this.camera.position.set(0, 800, 1000);

    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;

    // Orbit Controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.1; // Don't allow camera to go below ground
    this.controls.minDistance = 20;
    this.controls.maxDistance = 3000;

    // 2. Lighting setup
    this.ambientLight = new THREE.AmbientLight(0x222630, 0.6);
    this.scene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    this.sunLight.position.set(-500, 800, -500);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 4000;
    const d = 1000;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.sunLight = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.scene.add(this.sunLight);

    // 3. Terrain Mesh Setup (256x256 mesh resolution)
    this.terrainWidth = 256;
    this.terrainHeight = 256;
    this.geometry = new THREE.PlaneGeometry(2000, 2000, 255, 255);
    this.geometry.rotateX(-Math.PI / 2); // orient flat

    // Textures
    this.heightmapTex = null;
    this.normalmapTex = null;
    this.weatherTex = null;

    // Custom Shader Material for Dynamic 3D Terrain
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tHeight: { value: null },
        tNormal: { value: null },
        tWeather: { value: null },
        activeLayer: { value: 0 }, // 0=Terrain, 1=Temp, 2=Moisture, 3=Pressure
        timeOfDay: { value: 480.0 },
        uLightDir: { value: new THREE.Vector3(-0.5, 0.8, -0.5) },
        uLightColor: { value: new THREE.Color(1.0, 1.0, 1.0) }
      },
      vertexShader: `
        uniform sampler2D tHeight;
        uniform sampler2D tNormal;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying float vHeight;

        void main() {
          vUv = uv;
          // Sample displacement
          float height = texture2D(tHeight, uv).r;
          vHeight = height;
          
          vec3 pos = position;
          pos.y = height * 250.0; // scale elevation

          // Set normals
          vec3 n = texture2D(tNormal, uv).rgb * 2.0 - 1.0;
          vNormal = normalize(n);

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          vPosition = mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
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
          
          // Use dynamic sun direction
          vec3 lightDir = normalize(uLightDir);
          float diffuse = max(0.12, dot(normal, lightDir));

          // Sample dynamic weather grids:
          vec4 wData = texture2D(tWeather, vUv);
          float temp = wData.r;
          float moist = wData.g;
          float rain = wData.b;
          float snow = wData.a;

          vec3 baseColor = vec3(0.3, 0.45, 0.2); // grass default

          if (activeLayer == 0 || activeLayer == 2) {
            // Terrain base (standard geographic colors)
            if (vHeight < 0.08) {
              baseColor = vec3(0.08, 0.18, 0.36); // water
            } else if (vHeight < 0.12) {
              baseColor = vec3(0.85, 0.82, 0.65); // sand
            } else if (vHeight > 0.6) {
              baseColor = vec3(0.95, 0.95, 0.95); // snow capped peaks
            } else if (vHeight > 0.45) {
              baseColor = vec3(0.45, 0.42, 0.38); // mountain rock
            } else {
              baseColor = mix(vec3(0.2, 0.4, 0.15), vec3(0.12, 0.3, 0.1), wData.g); // moist green forest
            }

            if (activeLayer == 2) {
              // Blend a beautiful semi-transparent blue moisture cloud layer on top
              if (moist > 0.35) {
                float blendFactor = (moist - 0.35) * 1.8;
                vec3 blueMoisture = vec3(0.05, 0.38, 0.85); // High-fantasy royal blue
                baseColor = mix(baseColor, blueMoisture, clamp(blendFactor * 0.7, 0.0, 0.7));
              }
            }
          } else if (activeLayer == 1) {
            // Temperature Gradient Overlay (blue to red)
            float normTemp = (temp + 10.0) / 45.0; // clamp typical range [-10C, 35C]
            baseColor = mix(vec3(0.0, 0.2, 0.8), vec3(0.9, 0.1, 0.1), clamp(normTemp, 0.0, 1.0));
          } else if (activeLayer == 3) {
            // Pressure Overlay (High pressure = yellow, Low = deep purple)
            float press = 1013.0 - vHeight * 120.0;
            float normPress = (press - 890.0) / 130.0;
            baseColor = mix(vec3(0.25, 0.0, 0.4), vec3(0.85, 0.8, 0.1), clamp(normPress, 0.0, 1.0));
          }

          // Ambient day/night baseline
          float hour = timeOfDay / 60.0;
          float nightFactor = max(0.12, sin((hour - 6.0) * 3.14159 / 12.0));
          vec3 ambient = vec3(0.16, 0.18, 0.24) * nightFactor;
          
          // Apply lighting equation
          float brightnessBoost = 1.35;
          vec3 finalColor = baseColor * (diffuse * uLightColor * brightnessBoost + ambient);
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });

    this.terrainMesh = new THREE.Mesh(this.geometry, this.material);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;
    this.scene.add(this.terrainMesh);

    // 4. Weather Particles Setup
    this.rainParticles = null;
    this.snowParticles = null;
    this.moistureParticles = null;
    this.initPrecipitationParticles();

    // 5. Landmark Markers
    this.markers = [];
    this.landmarkGroup = new THREE.Group();
    this.scene.add(this.landmarkGroup);

    // Listen for resize
    window.addEventListener('resize', () => this.onResize());

    // Load terrain textures from server
    this.isTerrainLoaded = false;
    this.loadTerrainTextures();
  }

  loadTerrainTextures() {
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    const texLoader = new THREE.TextureLoader();
    texLoader.setCrossOrigin('anonymous');
    let loadedCount = 0;

    const onLoaded = () => {
      loadedCount++;
      if (loadedCount === 2) {
        this.isTerrainLoaded = true;
        console.log("[Client Renderer] Coarse terrain maps loaded successfully.");
      }
    };

    texLoader.load(`${apiProtocol}//${apiHost}/assets/heightmap_coarse.png`, (texture) => {
      texture.minFilter = THREE.LinearFilter;
      this.heightmapTex = texture;
      this.material.uniforms.tHeight.value = texture;
      onLoaded();
    });

    texLoader.load(`${apiProtocol}//${apiHost}/assets/normalmap_coarse.jpg`, (texture) => {
      texture.minFilter = THREE.LinearFilter;
      this.normalmapTex = texture;
      this.material.uniforms.tNormal.value = texture;
      onLoaded();
    });
  }

  initPrecipitationParticles() {
    const particleCount = 4000;
    
    // Rain particle system
    const rainGeo = new THREE.BufferGeometry();
    const rainPositions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i += 3) {
      rainPositions[i] = Math.random() * 2000 - 1000;
      rainPositions[i + 1] = Math.random() * 400; // altitude
      rainPositions[i + 2] = Math.random() * 2000 - 1000;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
    
    const rainMat = new THREE.PointsMaterial({
      color: 0x6688cc,
      size: 1.8,
      transparent: true,
      opacity: 0.7,
      depthWrite: false
    });
    this.rainParticles = new THREE.Points(rainGeo, rainMat);
    this.scene.add(this.rainParticles);

    // Snow particle system
    const snowGeo = new THREE.BufferGeometry();
    const snowPositions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount * 3; i += 3) {
      snowPositions[i] = Math.random() * 2000 - 1000;
      snowPositions[i + 1] = Math.random() * 400;
      snowPositions[i + 2] = Math.random() * 2000 - 1000;
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPositions, 3));
    
    const snowMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 3.0,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    });
    this.snowParticles = new THREE.Points(snowGeo, snowMat);
    this.scene.add(this.snowParticles);

    // Moisture cloud particle system
    const moistureCount = 6000;
    const moistureGeo = new THREE.BufferGeometry();
    const moisturePositions = new Float32Array(moistureCount * 3);
    for (let i = 0; i < moistureCount * 3; i += 3) {
      moisturePositions[i] = Math.random() * 2000 - 1000;
      moisturePositions[i + 1] = -1000.0; // Hide initially
      moisturePositions[i + 2] = Math.random() * 2000 - 1000;
    }
    moistureGeo.setAttribute('position', new THREE.BufferAttribute(moisturePositions, 3));
    
    const moistureMat = new THREE.PointsMaterial({
      color: 0x4da6ff,
      size: 20.0,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.moistureParticles = new THREE.Points(moistureGeo, moistureMat);
    this.scene.add(this.moistureParticles);
  }

  updatePrecipitation(physics, activeLayer) {
    // Animate falling particles based on local wind and precipitation rates
    const rainPos = this.rainParticles.geometry.attributes.position.array;
    const snowPos = this.snowParticles.geometry.attributes.position.array;
    const count = rainPos.length;

    // Check weather layers
    for (let i = 0; i < count; i += 3) {
      // Map world position [-1000, 1000] to UV coordinates [0, 1] for rain
      const ru = (rainPos[i] + 1000) / 2000;
      const rv = 1.0 - (rainPos[i + 2] + 1000) / 2000;
      const rStats = physics.getWeatherAt(ru, rv);
      const rGroundHeight = rStats.altitude / 3800 * 250.0;
      
      const isRaining = (rStats.rain >= 10);
      
      if (isRaining) {
        rainPos[i + 1] -= 8.5; // fall speed
        rainPos[i] += rStats.windSpeed * Math.sin(rStats.windAngle * Math.PI / 180.0) * 0.05;
        rainPos[i + 2] -= rStats.windSpeed * Math.cos(rStats.windAngle * Math.PI / 180.0) * 0.05;
        
        // Reset/Wrap if it falls below ground or drifts out of bounds
        if (rainPos[i + 1] < rGroundHeight || rainPos[i + 1] > 600) {
          rainPos[i + 1] = 400; // Reset to cloud level
          rainPos[i] = Math.random() * 2000 - 1000;
          rainPos[i + 2] = Math.random() * 2000 - 1000;
        }
      } else {
        // Hide rain particle underground
        rainPos[i + 1] = -1000.0;
      }

      // Map world position [-1000, 1000] to UV coordinates [0, 1] for snow
      const su = (snowPos[i] + 1000) / 2000;
      const sv = 1.0 - (snowPos[i + 2] + 1000) / 2000;
      const sStats = physics.getWeatherAt(su, sv);
      const sGroundHeight = sStats.altitude / 3800 * 250.0;
      
      const isSnowing = (sStats.snow >= 10);

      if (isSnowing) {
        snowPos[i + 1] -= 2.0; // slow drift
        snowPos[i] += Math.sin(i + snowPos[i + 1] * 0.02) * 0.5 + sStats.windSpeed * Math.sin(sStats.windAngle * Math.PI / 180.0) * 0.03;
        snowPos[i + 2] -= sStats.windSpeed * Math.cos(sStats.windAngle * Math.PI / 180.0) * 0.03;

        // Reset/Wrap
        if (snowPos[i + 1] < sGroundHeight || snowPos[i + 1] > 600) {
          snowPos[i + 1] = 400;
          snowPos[i] = Math.random() * 2000 - 1000;
          snowPos[i + 2] = Math.random() * 2000 - 1000;
        }
      } else {
        // Hide snow particle underground
        snowPos[i + 1] = -1000.0;
      }
    }

    // Update moisture cloud particles
    const moisturePos = this.moistureParticles.geometry.attributes.position.array;
    const moistureCount = moisturePos.length;
    for (let i = 0; i < moistureCount; i += 3) {
      if (activeLayer === 'moisture') {
        const mu = (moisturePos[i] + 1000) / 2000;
        const mv = 1.0 - (moisturePos[i + 2] + 1000) / 2000;
        const stats = physics.getWeatherAt(mu, mv);
        
        // Show billowy cloud particles only over high-moisture regions (seas, lakes, storm tracks)
        if (stats.moisture >= 55) {
          // Drifts slowly with local wind vectors
          moisturePos[i] += stats.windSpeed * Math.sin(stats.windAngle * Math.PI / 180.0) * 0.03;
          moisturePos[i + 2] -= stats.windSpeed * Math.cos(stats.windAngle * Math.PI / 180.0) * 0.03;
          
          // Volumetric 3D altitude distribution + gentle drifting oscillation
          const baseHeight = 120.0 + ((i % 101) / 101.0) * 140.0;
          moisturePos[i + 1] = baseHeight + Math.sin(i * 0.05 + performance.now() * 0.0008) * 8.0;

          // Wrap if it drifts too far out of bounds
          if (moisturePos[i] < -1000 || moisturePos[i] > 1000 || moisturePos[i + 2] < -1000 || moisturePos[i + 2] > 1000) {
            moisturePos[i] = Math.random() * 2000 - 1000;
            moisturePos[i + 2] = Math.random() * 2000 - 1000;
          }
        } else {
          moisturePos[i + 1] = -1000.0; // Hide
        }
      } else {
        moisturePos[i + 1] = -1000.0; // Hide
      }
    }

    this.rainParticles.geometry.attributes.position.needsUpdate = true;
    this.snowParticles.geometry.attributes.position.needsUpdate = true;
    this.moistureParticles.geometry.attributes.position.needsUpdate = true;
  }

  updateWeatherTexture(physics) {
    // Generate a dynamic data texture to pass server-side weather buffers directly to shaders
    const data = new Float32Array(this.terrainWidth * this.terrainHeight * 4);
    
    for (let i = 0; i < physics.size; i++) {
      const idx = i * 4;
      data[idx] = physics.temperature[i];
      data[idx + 1] = physics.moisture[i];
      data[idx + 2] = physics.rain[i];
      data[idx + 3] = physics.snow[i];
    }

    if (this.weatherTex) {
      this.weatherTex.image.data = data;
      this.weatherTex.needsUpdate = true;
    } else {
      this.weatherTex = new THREE.DataTexture(
        data,
        this.terrainWidth,
        this.terrainHeight,
        THREE.RGBAFormat,
        THREE.FloatType
      );
      this.weatherTex.minFilter = THREE.LinearFilter;
      this.weatherTex.magFilter = THREE.LinearFilter;
      this.weatherTex.needsUpdate = true;
      this.material.uniforms.tWeather.value = this.weatherTex;
    }
  }

  draw(physics, activeLayer, toggleWind, toggleWeather, toggleLandmarks, landmarks, selectedLandmarkId, timeOfDay) {
    // 1. Sync simulation time and overlays
    const layerIndices = { terrain: 0, temperature: 1, moisture: 2, pressure: 3 };
    this.material.uniforms.activeLayer.value = layerIndices[activeLayer] !== undefined ? layerIndices[activeLayer] : 0;
    this.material.uniforms.timeOfDay.value = timeOfDay;

    // Calculate dynamic light direction and color based on timeOfDay
    const hour = timeOfDay / 60.0;
    const angle = (hour - 6.0) * Math.PI / 12.0;
    const lightDir = new THREE.Vector3();
    const lightColor = new THREE.Color();

    if (hour >= 6.0 && hour <= 18.0) {
      // Day (Sun is up)
      const sinAngle = Math.sin(angle);
      const cosAngle = Math.cos(angle);
      
      lightDir.set(-cosAngle, sinAngle, -0.3).normalize();
      
      // Calculate golden hour color shifts (sunrise: 6.0-7.5, sunset: 16.5-18.0)
      const sunriseFactor = Math.max(0, 1 - Math.abs(hour - 6.5) * 1.5);
      const sunsetFactor = Math.max(0, 1 - Math.abs(hour - 17.5) * 1.5);
      const goldenHour = Math.max(sunriseFactor, sunsetFactor);
      
      // Interpolate from warm golden hour orange to midday bright white
      lightColor.setRGB(1.0, 0.95, 0.88); // Midday light
      if (goldenHour > 0) {
        lightColor.lerp(new THREE.Color(1.0, 0.58, 0.15), goldenHour);
      }
      
      // Update directional light source position and intensity
      this.sunLight.position.set(-cosAngle * 1000, sinAngle * 800, -500);
      this.sunLight.intensity = 1.6 * sinAngle;
      this.sunLight.color.copy(lightColor);
    } else {
      // Night (Moon is up)
      const moonAngle = (hour + 6.0) * Math.PI / 12.0;
      const sinMoon = Math.sin(moonAngle);
      const cosMoon = Math.cos(moonAngle);
      
      lightDir.set(-cosMoon, sinMoon, -0.3).normalize();
      lightColor.setRGB(0.12, 0.18, 0.32); // Cool moonlight
      
      this.sunLight.position.set(-cosMoon * 1000, sinMoon * 500, -500);
      this.sunLight.intensity = 0.35;
      this.sunLight.color.copy(lightColor);
    }

    // Sync light uniforms
    this.material.uniforms.uLightDir.value.copy(lightDir);
    this.material.uniforms.uLightColor.value.copy(lightColor);

    // 2. Upload weather buffers to GPU
    this.updateWeatherTexture(physics);

    // 3. Render precipitation particles
    this.rainParticles.visible = toggleWeather;
    this.snowParticles.visible = toggleWeather;
    this.moistureParticles.visible = (activeLayer === 'moisture');
    if (toggleWeather || activeLayer === 'moisture') {
      this.updatePrecipitation(physics, activeLayer);
    }

    // 4. Render Landmark Markers
    this.drawLandmarks(landmarks, selectedLandmarkId, toggleLandmarks, physics);

    // 5. Update controllers and render frame
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  drawLandmarks(landmarks, selectedId, visible, physics) {
    this.landmarkGroup.clear();
    if (!visible) return;

    landmarks.forEach(lm => {
      // Map normalized coordinates [0, 1] to world space [-1000, 1000]
      const wx = lm.x * 2000 - 1000;
      const wz = (1.0 - lm.y) * 2000 - 1000; // Y coordinates are inverted in WebGL space

      // Sample local elevation
      const weather = physics.getWeatherAt(lm.x, lm.y);
      const wy = (weather.altitude / 3800 * 250.0) + 12.0; // position slightly above peak

      const isSelected = lm.id === selectedId;

      // Draw Cone pin
      const coneGeo = new THREE.ConeGeometry(5, 18, 4);
      coneGeo.rotateX(Math.PI); // point down
      const coneMat = new THREE.MeshBasicMaterial({
        color: isSelected ? 0xffd700 : (lm.isPreset ? 0xccaa44 : 0x00ff88),
        wireframe: false
      });
      const coneMesh = new THREE.Mesh(coneGeo, coneMat);
      coneMesh.position.set(wx, wy + 10, wz);
      this.landmarkGroup.add(coneMesh);

      // Simple hovering label ring
      const ringGeo = new THREE.RingGeometry(8, 9, 8);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: isSelected ? 0xffd700 : 0xaa8833,
        side: THREE.DoubleSide
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.set(wx, wy - 10, wz);
      this.landmarkGroup.add(ringMesh);
    });
  }

  toggleOverheadView(enable) {
    this.isOverhead = enable;
    if (enable) {
      // Calculate camera height to fit the 2000x2000 map plane perfectly on screen
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const distV = 2000 / (2 * Math.tan(fovRad / 2));
      const distH = (2000 / this.camera.aspect) / (2 * Math.tan(fovRad / 2));
      const height = Math.max(distV, distH);

      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0, height, 0.1);
      this.controls.enableRotate = false;
    } else {
      this.camera.position.set(0, 800, 1000);
      this.controls.target.set(0, 0, 0);
      this.controls.enableRotate = true;
    }
    this.controls.update();
  }

  cacheTerrain(image) {
    // Stub to satisfy old drag-and-drop caching (terrain is loaded server-side now)
  }

  onResize() {
    const container = this.canvas.parentElement || this.canvas;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);

    if (this.isOverhead) {
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const distV = 2000 / (2 * Math.tan(fovRad / 2));
      const distH = (2000 / this.camera.aspect) / (2 * Math.tan(fovRad / 2));
      const height = Math.max(distV, distH);
      this.camera.position.set(0, height, 0.1);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }
}
