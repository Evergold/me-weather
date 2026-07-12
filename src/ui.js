// ui.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import { LandmarkManager } from './landmarks.js';

export function getCompassDir(deg) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round((deg % 360) / 45) % 8;
  return directions[index];
}

export class WeatherUI {
  constructor(physics, renderer, startSimulationLoop) {
    this.physics = physics;
    this.renderer = renderer;
    this.startSimulationLoop = startSimulationLoop;
    this.landmarkManager = new LandmarkManager();

    // Simulation settings to bind
    this.simSpeed = 1; // Speed multiplier (0 = paused)
    this.timeOfDay = 480; // minutes past midnight (8:00 AM)
    this.season = 'summer';
    this.globalWindSpeed = 15;
    this.globalWindAngle = 270;
    this.globalTempShift = 0;

    // Overlay Toggles
    this.activeLayer = 'terrain'; // 'terrain' | 'temperature' | 'moisture' | 'pressure'
    this.toggleWind = true;
    this.toggleWeather = true;
    this.toggleLandmarks = true;

    // Selection
    this.selectedLandmarkId = null;

    // Temp variables for custom pins
    this.pendingPinCoords = { x: 0, y: 0 };

    this.initDOMReferences();
    this.bindEvents();
    this.renderLandmarksList();
    this.autoLaunch();
  }

  initDOMReferences() {
    // Screens
    this.landingScreen = document.getElementById('landing-screen');
    this.dashboardScreen = document.getElementById('dashboard-screen');
    
    // File inputs
    this.dropZone = document.getElementById('drop-zone');
    this.fileInput = document.getElementById('file-input');
    
    // Control inputs
    this.btnPause = document.getElementById('btn-pause');
    this.sliderTime = document.getElementById('slider-time');
    this.valTime = document.getElementById('val-time');
    this.selectSeason = document.getElementById('select-season');
    
    this.sliderWindSpeed = document.getElementById('slider-wind-speed');
    this.valWindSpeed = document.getElementById('val-wind-speed');
    this.sliderWindDir = document.getElementById('slider-wind-dir');
    this.valWindDir = document.getElementById('val-wind-dir');
    this.sliderGlobalTemp = document.getElementById('slider-global-temp');
    this.valGlobalTemp = document.getElementById('val-global-temp');
    
    this.btnResetMap = document.getElementById('btn-reset-map');

    // Canvas
    this.canvas = document.getElementById('simulation-canvas');
    this.canvasContainer = document.getElementById('canvas-container');

    // Telemetry / HUD
    this.hudHour = document.getElementById('hud-hour');
    this.hudSeason = document.getElementById('hud-season');
    this.hudWindDir = document.getElementById('hud-wind-dir');
    
    this.hudValCoords = document.getElementById('hud-val-coords');
    this.hudValAlt = document.getElementById('hud-val-alt');
    this.hudValTemp = document.getElementById('hud-val-temp');
    this.hudValWind = document.getElementById('hud-val-wind');
    this.hudValRain = document.getElementById('hud-val-rain');
    this.hudValSnow = document.getElementById('hud-val-snow');

    // Sidebar lists
    this.watchlistContainer = document.getElementById('landmark-watchlist');

    // Custom Pin Dialog
    this.pinDialog = document.getElementById('pin-dialog');
    this.pinNameInput = document.getElementById('pin-name-input');
    this.btnPinCancel = document.getElementById('btn-pin-cancel');
    this.btnPinConfirm = document.getElementById('btn-pin-confirm');
  }

  autoLaunch() {
    // Automatically transition to the dashboard and trigger simulation start on load
    // only when the textures and WebSocket are fully connected and ready.
    const startTime = performance.now();
    const checkInterval = setInterval(() => {
      const elapsed = performance.now() - startTime;
      
      const isPhysicsReady = this.physics.isTerrainLoaded;
      const isRendererReady = this.renderer.isTerrainLoaded;
      const isSocketReady = this.physics.isConnected;

      // Force launch if it takes longer than 5 seconds as a safety fallback
      if ((isPhysicsReady && isRendererReady && isSocketReady) || elapsed > 5000) {
        clearInterval(checkInterval);
        console.log(`[UI] Launching dashboard. Setup took ${elapsed.toFixed(0)}ms. (Physics: ${isPhysicsReady}, Renderer: ${isRendererReady}, Socket: ${isSocketReady})`);
        
        this.landingScreen.classList.remove('active');
        this.dashboardScreen.classList.add('active');
        this.simSpeed = 1;
        this.physics.sendSettings({ simSpeed: 1 });
        this.startSimulationLoop();
        
        // Force resize to compute correct layout dimensions
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 50);
      }
    }, 100);
  }

  bindEvents() {
    // 0. Header Click Toggle (Overhead 2D Map View)
    const header = document.querySelector('.dashboard-header');
    if (header) {
      header.setAttribute('title', 'Click to toggle overhead 2D view');
      header.addEventListener('click', (e) => {
        // Prevent trigger when clicking interactive children inside the header (buttons, inputs)
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('a')) {
          return;
        }
        
        const isOverhead = this.dashboardScreen.classList.toggle('overhead-mode');
        this.renderer.toggleOverheadView(isOverhead);
        
        // Force layout repaint resize
        window.dispatchEvent(new Event('resize'));
      });
    }

    // 1. File Upload / Landing Events (Re-purposed to connect directly)
    this.dropZone.addEventListener('click', () => {
      this.landingScreen.classList.remove('active');
      this.dashboardScreen.classList.add('active');
      this.simSpeed = 1;
      this.physics.sendSettings({ simSpeed: 1 });
      this.startSimulationLoop();
    });
    
    this.fileInput.addEventListener('change', (e) => {
      // Direct load
      this.landingScreen.classList.remove('active');
      this.dashboardScreen.classList.add('active');
      this.simSpeed = 1;
      this.physics.sendSettings({ simSpeed: 1 });
      this.startSimulationLoop();
    });

    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('dragover');
    });

    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('dragover');
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      this.landingScreen.classList.remove('active');
      this.dashboardScreen.classList.add('active');
      this.simSpeed = 1;
      this.physics.sendSettings({ simSpeed: 1 });
      this.startSimulationLoop();
    });

    // 2. Dashboard Resets
    this.btnResetMap.addEventListener('click', () => {
      this.simSpeed = 0;
      this.physics.sendSettings({ simSpeed: 0 });
      this.dashboardScreen.classList.remove('active');
      this.landingScreen.classList.add('active');
      this.fileInput.value = '';
    });

    // 3. Playback Speeds
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.simSpeed = parseInt(btn.dataset.speed, 10);
        this.physics.sendSettings({ simSpeed: this.simSpeed });
      });
    });

    // 4. Time slider
    this.sliderTime.addEventListener('input', (e) => {
      this.timeOfDay = parseInt(e.target.value, 10);
      this.updateTimeDisplay();
      this.physics.sendSettings({ timeOfDay: this.timeOfDay });
    });

    // 5. Season Select
    this.selectSeason.addEventListener('change', (e) => {
      this.season = e.target.value;
      const displayNames = {
        spring: 'Mid-Spring',
        summer: 'Mid-Summer',
        autumn: 'Mid-Autumn',
        winter: 'Mid-Winter'
      };
      this.hudSeason.textContent = displayNames[this.season];
      this.physics.sendSettings({ season: this.season });
    });

    // 6. Wind & Temp sliders
    this.sliderWindSpeed.addEventListener('input', (e) => {
      this.globalWindSpeed = parseInt(e.target.value, 10);
      this.valWindSpeed.textContent = `${this.globalWindSpeed} kt`;
      this.physics.sendSettings({ windSpeed: this.globalWindSpeed });
    });

    // 7. Wind Direction
    this.sliderWindDir.addEventListener('input', (e) => {
      this.globalWindAngle = parseInt(e.target.value, 10);
      const dirStr = getCompassDir(this.globalWindAngle);
      this.valWindDir.textContent = `${this.globalWindAngle}° (${dirStr})`;
      this.hudWindDir.textContent = `${dirStr} (${this.globalWindAngle}°)`;
      this.physics.sendSettings({ windAngle: this.globalWindAngle });
    });

    // 8. Global Temp Shift
    this.sliderGlobalTemp.addEventListener('input', (e) => {
      this.globalTempShift = parseInt(e.target.value, 10);
      const prefix = this.globalTempShift > 0 ? '+' : '';
      this.valGlobalTemp.textContent = `${prefix}${this.globalTempShift}°C`;
      this.physics.sendSettings({ tempShift: this.globalTempShift });
    });

    // 7. Layer Selection Overlays
    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeLayer = btn.dataset.layer;
      });
    });

    // 8. Visual Effects Toggles
    document.querySelectorAll('.effect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const effect = btn.dataset.effect;
        if (effect === 'wind') this.toggleWind = !this.toggleWind;
        if (effect === 'weather') this.toggleWeather = !this.toggleWeather;
        if (effect === 'landmarks') this.toggleLandmarks = !this.toggleLandmarks;
      });
    });

    // 9. Canvas Hover Inspector
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      // Calculate mouse location normalized relative to the canvas draw area
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      this.updateHoverHUD(x, y);
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.resetHoverHUD();
    });

    // 10. Canvas Right-Click (Add Custom Pin)
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left) / rect.width;
      const clickY = (e.clientY - rect.top) / rect.height;

      // Show Pin naming Modal dialog
      this.pendingPinCoords = { x: clickX, y: clickY };
      this.pinNameInput.value = '';
      this.pinDialog.classList.add('active');
      setTimeout(() => this.pinNameInput.focus(), 150);
    });

    // Cancel Custom Pin
    this.btnPinCancel.addEventListener('click', () => {
      this.pinDialog.classList.remove('active');
    });

    // Confirm Custom Pin
    this.btnPinConfirm.addEventListener('click', () => this.placeCustomPin());
    this.pinNameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.placeCustomPin();
    });
  }

  /**
   * Reads the uploaded heightmap image, feeds physics and renderer, starts sim
   */
  handleHeightmapUpload(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Initialize Renderer and Physics with this heightmap
        this.renderer.cacheTerrain(img);
        this.physics.setHeightmap(img);

        // Transition views
        this.landingScreen.classList.remove('active');
        this.dashboardScreen.classList.add('active');

        // Play sim
        this.simSpeed = 1;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.speed-btn[data-speed="1"]').classList.add('active');

        this.startSimulationLoop();
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  /**
   * Places the custom pin, registers it, updates sidebar and saves
   */
  placeCustomPin() {
    let name = this.pinNameInput.value.trim();
    if (!name) name = `Station ${this.landmarkManager.customPins.length + 1}`;

    const newPin = this.landmarkManager.addCustomPin(name, this.pendingPinCoords.x, this.pendingPinCoords.y);
    this.selectedLandmarkId = newPin.id;

    this.pinDialog.classList.remove('active');
    this.renderLandmarksList();
  }

  /**
   * Refreshes the watch list of landmarks in the sidebar
   */
  renderLandmarksList() {
    const list = this.landmarkManager.updateLandmarkWeather(this.physics);
    this.watchlistContainer.innerHTML = '';

    list.forEach(lm => {
      const item = document.createElement('div');
      item.className = `landmark-item ${lm.isPreset ? '' : 'custom-pin'} ${lm.id === this.selectedLandmarkId ? 'selected' : ''}`;
      
      // Determine weather condition emoji icon
      let icon = '☀️';
      if (lm.weather) {
        const cond = lm.weather.condition;
        if (cond.includes('Rain')) icon = '🌧️';
        else if (cond.includes('Snow') || cond.includes('Blizzard')) icon = '❄️';
        else if (cond.includes('Foggy')) icon = '🌫️';
        else if (cond.includes('Cloud')) icon = '🌤️';
      }

      item.innerHTML = `
        <div class="landmark-meta">
          <span class="landmark-name">${lm.name}</span>
          <span class="landmark-type">${lm.type}</span>
        </div>
        <div class="landmark-weather">
          <span class="landmark-temp">${lm.weather ? lm.weather.temperature : '--'}°C</span>
          <span class="landmark-condition-icon" title="${lm.weather ? lm.weather.condition : ''}">${icon}</span>
          ${!lm.isPreset ? `
            <button class="btn-remove-pin" data-id="${lm.id}" title="Remove weather station">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0" width="14" height="14">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          ` : ''}
        </div>
      `;

      // Click to select/highlight landmark
      item.addEventListener('click', (e) => {
        // Prevent click if clicking the delete button
        if (e.target.closest('.btn-remove-pin')) return;

        if (this.selectedLandmarkId === lm.id) {
          this.selectedLandmarkId = null; // Toggle off selection
        } else {
          this.selectedLandmarkId = lm.id;
        }
        this.renderLandmarksList();
      });

      // Remove pin listener
      if (!lm.isPreset) {
        const removeBtn = item.querySelector('.btn-remove-pin');
        removeBtn.addEventListener('click', () => {
          this.landmarkManager.removeCustomPin(lm.id);
          if (this.selectedLandmarkId === lm.id) this.selectedLandmarkId = null;
          this.renderLandmarksList();
        });
      }

      this.watchlistContainer.appendChild(item);
    });
  }

  /**
   * Increments the time of day by the speed factor
   */
  advanceTime(dt) {
    if (this.simSpeed === 0) return;
    
    // speed 1 = 1 minute of simulation per real-world second
    // dt is time step in seconds
    const minutesToAdd = dt * this.simSpeed * 10; // speeds: 1x, 3x, 10x
    this.timeOfDay = (this.timeOfDay + minutesToAdd) % 1439;

    // Update Slider & HUD value
    this.sliderTime.value = Math.floor(this.timeOfDay);
    this.updateTimeDisplay();
  }

  updateTimeDisplay() {
    const hours = Math.floor(this.timeOfDay / 60);
    const minutes = Math.floor(this.timeOfDay % 60);
    
    const hStr = hours.toString().padStart(2, '0');
    const mStr = minutes.toString().padStart(2, '0');
    const timeStr = `${hStr}:${mStr}`;

    this.valTime.textContent = timeStr;
    this.hudHour.textContent = timeStr;
  }

  updateHoverHUD(x, y) {
    // Round percentages
    const px = Math.round(x * 100);
    const py = Math.round(y * 100);
    this.hudValCoords.textContent = `${px}% X, ${py}% Y`;

    // Query physics values
    const weather = this.physics.getWeatherAt(x, y);

    this.hudValAlt.textContent = `${weather.altitude}m`;
    this.hudValTemp.textContent = `${weather.temperature}°C`;
    
    const dirStr = getCompassDir(weather.windAngle);
    this.hudValWind.textContent = `${weather.windSpeed} kt (${dirStr})`;
    
    this.hudValRain.textContent = `${weather.rain}%`;
    this.hudValSnow.textContent = `${weather.snow}%`;
  }

  resetHoverHUD() {
    this.hudValCoords.textContent = '-- , --';
    this.hudValAlt.textContent = '0m';
    this.hudValTemp.textContent = '--°C';
    this.hudValWind.textContent = '-- knots';
    this.hudValRain.textContent = '0%';
    this.hudValSnow.textContent = '0%';
  }
}
