/**
 * Middle-earth Weather Simulator Renderer
 * Handles drawing the hillshaded terrain, physics heatmaps (temperature, moisture, pressure),
 * wind flow vector fields, rain/snow particle systems, and landmark markers.
 */

export class WeatherRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    
    // Caches
    this.terrainCanvas = document.createElement('canvas'); // Caches colorized & hillshaded terrain
    this.heightmapImage = null;
    this.heightmapWidth = 0;
    this.heightmapHeight = 0;

    // Simulation reference
    this.physics = null;

    // Particle Systems
    this.windParticles = [];
    this.maxWindParticles = 600;
    
    this.precipParticles = [];
    this.maxPrecipParticles = 1200;

    this.initParticles();
  }

  initParticles() {
    // Wind Flow Particles
    this.windParticles = [];
    for (let i = 0; i < this.maxWindParticles; i++) {
      this.windParticles.push({
        x: Math.random(),
        y: Math.random(),
        prevX: 0,
        prevY: 0,
        age: Math.random() * 100,
        maxAge: 100 + Math.random() * 150,
        speedMultiplier: 0.5 + Math.random() * 0.5
      });
    }

    // Precipitation Particles
    this.precipParticles = [];
    for (let i = 0; i < this.maxPrecipParticles; i++) {
      this.precipParticles.push({
        x: Math.random(),
        y: Math.random(),
        speed: 2 + Math.random() * 3,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.05 + Math.random() * 0.05,
        size: 1 + Math.random() * 1.5
      });
    }
  }

  /**
   * Colorizes the grayscale heightmap and applies Lambertian hillshading.
   * Caches the output in an offscreen canvas.
   */
  cacheTerrain(image) {
    this.heightmapImage = image;
    this.heightmapWidth = image.width;
    this.heightmapHeight = image.height;

    // Set canvas sizes to match heightmap
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.terrainCanvas.width = image.width;
    this.terrainCanvas.height = image.height;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = image.width;
    tempCanvas.height = image.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(image, 0, 0);

    const imgData = tempCtx.getImageData(0, 0, image.width, image.height);
    const pixels = imgData.data;

    const terrainCtx = this.terrainCanvas.getContext('2d');
    const terrainImgData = terrainCtx.createImageData(image.width, image.height);
    const outPixels = terrainImgData.data;

    const w = image.width;
    const h = image.height;

    // Hillshading Parameters
    // Sun direction: North-West (-1, -1, 1.2)
    const sunX = -0.707;
    const sunY = -0.707;
    const sunZ = 0.8;
    const sunLen = Math.sqrt(sunX*sunX + sunY*sunY + sunZ*sunZ);
    const lx = sunX / sunLen;
    const ly = sunY / sunLen;
    const lz = sunZ / sunLen;

    const shadeStrength = 12.0; // scale elevation slope for shadows

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;

        // Get height [0, 1] of current pixel and neighbors
        const height = pixels[idx] / 255.0;

        // Neighboring heights for gradient calculation (sobel-like)
        const idxR = (y * w + Math.min(w - 1, x + 1)) * 4;
        const idxL = (y * w + Math.max(0, x - 1)) * 4;
        const idxD = (Math.min(h - 1, y + 1) * w + x) * 4;
        const idxU = (Math.max(0, y - 1) * w + x) * 4;

        const hR = pixels[idxR] / 255.0;
        const hL = pixels[idxL] / 255.0;
        const hD = pixels[idxD] / 255.0;
        const hU = pixels[idxU] / 255.0;

        // Normal components
        const nx = (hL - hR) * shadeStrength;
        const ny = (hU - hD) * shadeStrength;
        const nz = 1.0;

        // Normalize surface normal
        const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
        const normalX = nx / nLen;
        const normalY = ny / nLen;
        const normalZ = nz / nLen;

        // Calculate diffuse lighting (Lambertian)
        const dot = normalX * lx + normalY * ly + normalZ * lz;
        const shade = 0.5 + dot * 0.5; // range [0, 1]

        // Map height to terrain color palette
        let r = 0, g = 0, b = 0;

        if (height < 0.08) {
          // Ocean depth mapping
          const depth = height / 0.08;
          r = Math.round(11 * depth + 4);    // 4 to 15
          g = Math.round(25 * depth + 14);   // 14 to 39
          b = Math.round(45 * depth + 25);   // 25 to 70
        } else if (height < 0.12) {
          // Sandy Shore / Plains border
          const t = (height - 0.08) / 0.04;
          r = Math.round(155 * (1-t) + 40 * t);
          g = Math.round(141 * (1-t) + 68 * t);
          b = Math.round(108 * (1-t) + 42 * t);
        } else if (height < 0.38) {
          // Plains to Forest/Hill Green
          const t = (height - 0.12) / 0.26;
          // Deep Forest Green to Highland Olive
          r = Math.round(30 * (1-t) + 55 * t);
          g = Math.round(62 * (1-t) + 75 * t);
          b = Math.round(40 * (1-t) + 52 * t);
        } else if (height < 0.65) {
          // Mountain Foothills (Brownish Slate)
          const t = (height - 0.38) / 0.27;
          r = Math.round(55 * (1-t) + 82 * t);
          g = Math.round(75 * (1-t) + 80 * t);
          b = Math.round(52 * (1-t) + 78 * t);
        } else if (height < 0.82) {
          // Craggy Ridges (Dark Grey Rock)
          const t = (height - 0.65) / 0.17;
          r = Math.round(82 * (1-t) + 42 * t);
          g = Math.round(80 * (1-t) + 42 * t);
          b = Math.round(78 * (1-t) + 42 * t);
        } else {
          // Snow Caps
          const t = (height - 0.82) / 0.18;
          r = Math.round(42 * (1-t) + 245 * t);
          g = Math.round(42 * (1-t) + 248 * t);
          b = Math.round(42 * (1-t) + 252 * t);
        }

        // Apply hillshading (darken shadows, brighten highlight slopes)
        // Shade is [0, 1]. Let's multiply color by shade * 1.5, clamped.
        const lightMult = shade * 1.6;
        outPixels[idx] = Math.min(255, r * lightMult);
        outPixels[idx + 1] = Math.min(255, g * lightMult);
        outPixels[idx + 2] = Math.min(255, b * lightMult);
        outPixels[idx + 3] = 255; // Alpha
      }
    }

    terrainCtx.putImageData(terrainImgData, 0, 0);
  }

  /**
   * Main Render Call
   */
  draw(physics, activeLayer, toggleWind, toggleWeather, toggleLandmarks, landmarks, selectedLandmarkId, timeOfDay) {
    this.physics = physics;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 1. Draw Base Terrain
    this.ctx.drawImage(this.terrainCanvas, 0, 0);

    // 2. Draw Active Meteorological Overlay
    if (activeLayer !== 'terrain') {
      this.drawLayerOverlay(activeLayer);
    }

    // 3. Draw Ambient Day/Night Lighting Filter
    this.drawDayNightFilter(timeOfDay);

    // 4. Update and Draw Wind Stream Particles
    if (toggleWind) {
      this.drawWindFlow();
    }

    // 5. Update and Draw Weather Precipitation Particles (Rain/Snow)
    if (toggleWeather) {
      this.drawPrecipitation();
    }

    // 6. Draw Landmarks & Custom Pins
    if (toggleLandmarks) {
      this.drawLandmarks(landmarks, selectedLandmarkId);
    }
  }

  /**
   * Renders colorized heatmaps for Temperature, Moisture, or Pressure fields
   * over the map with bilinear upscaling.
   */
  drawLayerOverlay(layer) {
    const w = this.physics.width;
    const h = this.physics.height;

    // Create a 128x128 image offscreen representing the layer data
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let i = 0; i < this.physics.size; i++) {
      const idx = i * 4;

      if (layer === 'temperature') {
        // Temperature heatmap scale: -15°C (pure blue) to 35°C (pure red)
        const temp = this.physics.temperature[i];
        const normalized = Math.max(0, Math.min(1.0, (temp + 15) / 50)); // map [-15, 35] to [0, 1]
        
        // Cold is blue, Mild is green, Hot is red
        if (normalized < 0.5) {
          const t = normalized * 2; // 0 to 1
          data[idx] = 0;
          data[idx + 1] = Math.round(150 * t);
          data[idx + 2] = Math.round(255 * (1 - t) + 100 * t);
        } else {
          const t = (normalized - 0.5) * 2; // 0 to 1
          data[idx] = Math.round(255 * t + 100 * (1 - t));
          data[idx + 1] = Math.round(150 * (1 - t));
          data[idx + 2] = 0;
        }
        data[idx + 3] = 110; // transparency overlay

      } else if (layer === 'moisture') {
        // Moisture scale: 0% (transparent/dry) to 100% (saturated blue)
        const moisture = this.physics.moisture[i];
        data[idx] = 40;
        data[idx + 1] = 100;
        data[idx + 2] = 230;
        data[idx + 3] = Math.round(moisture * 140); // density maps to opacity

      } else if (layer === 'pressure') {
        // Pressure scale: 950 hPa (low, deep violet) to 1025 hPa (high, bright orange)
        const p = this.physics.pressure[i];
        const normalized = Math.max(0, Math.min(1.0, (p - 950) / 75)); // range [950, 1025]
        
        // Violet (low) -> Teal -> Gold (high)
        if (normalized < 0.5) {
          const t = normalized * 2;
          data[idx] = Math.round(138 * (1 - t) + 20 * t);
          data[idx + 1] = Math.round(43 * (1 - t) + 160 * t);
          data[idx + 2] = Math.round(226 * (1 - t) + 180 * t);
        } else {
          const t = (normalized - 0.5) * 2;
          data[idx] = Math.round(20 * (1 - t) + 230 * t);
          data[idx + 1] = Math.round(160 * (1 - t) + 150 * t);
          data[idx + 2] = Math.round(180 * (1 - t) + 30 * t);
        }
        data[idx + 3] = 100; // opacity
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Drawstretched offscreen canvas onto the main canvas (smooth bilinear filtering)
    this.ctx.save();
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(offscreen, 0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  /**
   * Applies an ambient overlay matching the daylight cycle.
   * Noon is clear, evening is amber, night is deep dark violet-blue.
   */
  drawDayNightFilter(timeOfDay) {
    const hour = timeOfDay / 60;
    let r = 0, g = 0, b = 0, alpha = 0;

    // Simple time-of-day color interpolation
    if (hour < 4 || hour > 21) {
      // Midnight (deep dark indigo)
      r = 10; g = 12; b = 25; alpha = 0.45;
    } else if (hour >= 4 && hour < 7) {
      // Sunrise (soft amber glow)
      const t = (hour - 4) / 3;
      r = Math.round(250 * (1 - t) + 10 * t);
      g = Math.round(120 * (1 - t) + 10 * t);
      b = Math.round(50 * (1 - t) + 10 * t);
      alpha = 0.35 * (1 - t);
    } else if (hour >= 7 && hour <= 17) {
      // Full daylight (completely clear/unfiltered)
      alpha = 0;
    } else if (hour > 17 && hour <= 21) {
      // Sunset (deep orange-purple fading into night)
      const t = (hour - 17) / 4;
      r = Math.round(220 * (1 - t) + 10 * t);
      g = Math.round(70 * (1 - t) + 12 * t);
      b = Math.round(110 * (1 - t) + 25 * t);
      alpha = 0.1 * (1 - t) + 0.45 * t;
    }

    if (alpha > 0) {
      this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /**
   * Animates flowing streamlines along the wind vector field
   */
  drawWindFlow() {
    this.ctx.save();
    this.ctx.lineWidth = 1.0;
    
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let i = 0; i < this.maxWindParticles; i++) {
      const p = this.windParticles[i];

      // Store previous coordinates for drawing lines
      p.prevX = p.x * w;
      p.prevY = p.y * h;

      // Sample local wind vector (normalized coordinates)
      const weather = this.physics.getWeatherAt(p.x, p.y);
      
      // Scale wind speed relative to canvas grid dimensions
      // Convert windAngle & windSpeed back into canvas translation velocity
      const rad = (weather.windAngle * Math.PI) / 180;
      const speed = Math.max(0.2, weather.windSpeed * 0.04) * p.speedMultiplier;
      
      // Move particle
      p.x += (Math.sin(rad) * speed) / w;
      p.y += (-Math.cos(rad) * speed) / h;

      // Draw particle line
      const currentX = p.x * w;
      const currentY = p.y * h;

      // Opacity fades out at edges of age
      let opacity = 0.25;
      if (p.age < 30) opacity = (p.age / 30) * 0.25;
      else if (p.age > p.maxAge - 30) opacity = ((p.maxAge - p.age) / 30) * 0.25;

      this.ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
      this.ctx.beginPath();
      this.ctx.moveTo(p.prevX, p.prevY);
      this.ctx.lineTo(currentX, currentY);
      this.ctx.stroke();

      p.age += 1;

      // Reset condition: out of bounds or expired
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1 || p.age >= p.maxAge) {
        p.x = Math.random();
        p.y = Math.random();
        p.age = 0;
        p.maxAge = 100 + Math.random() * 150;
      }
    }

    this.ctx.restore();
  }

  /**
   * Draws falling rain streaks or drifting snow particles
   */
  drawPrecipitation() {
    this.ctx.save();
    
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let i = 0; i < this.maxPrecipParticles; i++) {
      const p = this.precipParticles[i];

      // Sample local weather values to decide if there is rain or snow
      const weather = this.physics.getWeatherAt(p.x, p.y);
      const isRaining = weather.rain > 0;
      const isSnowing = weather.snow > 0;

      // Move particle (always falls down, plus wind steering)
      const rad = (weather.windAngle * Math.PI) / 180;
      const windSteerX = Math.sin(rad) * (weather.windSpeed * 0.15);
      
      if (isSnowing) {
        // Snow drifts slowly downwards, with a light cosine wave wobble
        p.y += (1.0 + p.speed * 0.2) / h;
        p.wobble += p.wobbleSpeed;
        p.x += (windSteerX * 0.1 + Math.cos(p.wobble) * 0.4) / w;

        // Draw snow flake (soft white circle)
        if (weather.snow > 5) {
          const opacity = Math.min(0.8, (weather.snow / 100) * 0.9);
          this.ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
          this.ctx.beginPath();
          this.ctx.arc(p.x * w, p.y * h, p.size, 0, Math.PI * 2);
          this.ctx.fill();
        }
      } else {
        // Rain falls quickly downwards and is strongly sheared by wind
        const prevPX = p.x * w;
        const prevPY = p.y * h;

        p.y += (6.0 + p.speed * 1.5) / h;
        p.x += (windSteerX * 0.6) / w;

        // Draw rain streak (thin blue-grey line)
        if (weather.rain > 5) {
          const opacity = Math.min(0.6, (weather.rain / 100) * 0.7);
          this.ctx.strokeStyle = `rgba(135, 175, 215, ${opacity})`;
          this.ctx.lineWidth = 1.0;
          this.ctx.beginPath();
          this.ctx.moveTo(prevPX, prevPY);
          this.ctx.lineTo(p.x * w, p.y * h);
          this.ctx.stroke();
        }
      }

      // Wrap-around bounds reset
      if (p.y > 1.0 || p.x < 0 || p.x > 1.0) {
        p.y = 0;
        p.x = Math.random();
        p.speed = 2 + Math.random() * 3;
      }
    }

    this.ctx.restore();
  }

  /**
   * Draws interactive land markers and labels for weather stations
   */
  drawLandmarks(landmarks, selectedId) {
    this.ctx.save();
    
    const w = this.canvas.width;
    const h = this.canvas.height;

    landmarks.forEach(lm => {
      const cx = lm.x * w;
      const cy = lm.y * h;
      const isSelected = lm.id === selectedId;

      // Draw Marker Ring
      this.ctx.shadowBlur = isSelected ? 12 : 4;
      this.ctx.shadowColor = lm.isPreset ? '#e2c175' : '#f5a623';

      this.ctx.strokeStyle = lm.isPreset ? '#e2c175' : '#f5a623';
      this.ctx.lineWidth = isSelected ? 3.0 : 1.5;
      
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, isSelected ? 8 : 5, 0, Math.PI * 2);
      this.ctx.stroke();

      // Inner dot
      this.ctx.fillStyle = isSelected ? '#ffd700' : (lm.isPreset ? '#e2c175' : '#f5a623');
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, isSelected ? 3.5 : 2, 0, Math.PI * 2);
      this.ctx.fill();
      
      this.ctx.shadowBlur = 0; // reset shadow

      // Draw floating weather summary text
      if (lm.weather) {
        const textYOffset = isSelected ? -16 : -11;
        this.ctx.font = isSelected ? 'bold 10px JetBrains Mono' : '9px JetBrains Mono';
        
        // Background capsule for high legibility
        const nameText = lm.name;
        const tempText = `${lm.weather.temperature}°C`;
        const summaryText = `${nameText} (${tempText})`;
        
        this.ctx.font = isSelected ? 'bold 9px JetBrains Mono' : '8px JetBrains Mono';
        const textWidth = this.ctx.measureText(summaryText).width;
        const padX = 4;
        const padY = 2;

        this.ctx.fillStyle = 'rgba(11, 13, 16, 0.85)';
        this.ctx.strokeStyle = isSelected ? '#ffd700' : 'rgba(212, 175, 55, 0.2)';
        this.ctx.lineWidth = 1.0;
        
        const rx = cx - textWidth / 2 - padX;
        const ry = cy + textYOffset - 8;
        const rw = textWidth + padX * 2;
        const rh = 12 + padY * 2;

        this.ctx.beginPath();
        this.ctx.roundRect(rx, ry, rw, rh, 3);
        this.ctx.fill();
        this.ctx.stroke();

        // Print text
        this.ctx.fillStyle = isSelected ? '#ffd700' : '#e3e8ef';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(summaryText, cx, cy + textYOffset);
      }
    });

    this.ctx.restore();
  }
}
