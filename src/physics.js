// physics.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

/**
 * Middle-earth Weather Simulator - Client-Side Physics Sync & Telemetry
 * Handles the WebSocket connection to the Python server, decodes binary ArrayBuffers (Float16),
 * holds local downsampled overlays/chunks, and bilinearly interpolates stats for UI hover telemetry.
 */

// Float16 Decoder Helper
function decodeFloat16(buffer) {
  const val = new Uint16Array(buffer);
  const len = val.length;
  const float32 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const h = val[i];
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) {
      float32[i] = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    } else if (e === 31) {
      float32[i] = f ? NaN : ((s ? -1 : 1) * Infinity);
    } else {
      float32[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    }
  }
  return float32;
}

export class WeatherPhysics {
  constructor(width = 1024, height = 1024) {
    this.width = width;
    this.height = height;
    this.size = width * height;

    // Simulation fields (locally synchronized from server)
    this.heightmap = new Float32Array(this.size);
    this.temperature = new Float32Array(this.size);
    this.pressure = new Float32Array(this.size); // optional display
    this.moisture = new Float32Array(this.size);
    this.windX = new Float32Array(this.size);
    this.windY = new Float32Array(this.size);
    this.rain = new Float32Array(this.size);
    this.snow = new Float32Array(this.size);
    this.isWater = new Uint8Array(this.size);

    // WebSocket state
    this.clientId = 'client-' + Math.random().toString(36).substring(2, 9);
    this.ws = null;
    this.isConnected = false;

    // Camera settings to push to server
    this.pushRate = '1000ms';
    this.zoomedIn = false;
    this.focusX = 0.5;
    this.focusY = 0.5;

    // Local heightmap load state
    this.isTerrainLoaded = false;
    this.loadCoarseTerrain();
    this.initWebSocket();
  }

  loadCoarseTerrain() {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, this.width, this.height);
      const imgData = ctx.getImageData(0, 0, this.width, this.height);
      const data = imgData.data;

      for (let i = 0; i < this.size; i++) {
        const hVal = data[i * 4] / 255.0;
        this.heightmap[i] = hVal;
        this.isWater[i] = hVal < 0.08 ? 1 : 0;
      }
      this.isTerrainLoaded = true;
      console.log("[Client Physics] Coarse terrain map loaded and mapped.");
    };
    const apiHost = `${window.location.hostname}:8000`;
    const apiProtocol = window.location.protocol;
    img.src = `${apiProtocol}//${apiHost}/assets/heightmap_coarse.png`;
  }

  initWebSocket() {
    const apiHost = `${window.location.hostname}:8000`;
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProto}://${apiHost}/ws/${this.clientId}`;
    console.log(`[WebSocket] Connecting to ${wsUrl}...`);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log("[WebSocket] Connection established.");
      this.sendSettings();
    };

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.unpackBinaryFrame(event.data);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      console.log("[WebSocket] Connection lost. Reconnecting in 3s...");
      setTimeout(() => this.initWebSocket(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error("[WebSocket] Socket error:", err);
    };
  }

  unpackBinaryFrame(buffer) {
    const view = new DataView(buffer);
    const typeHeader = view.getUint8(0); // first byte
    const payload = buffer.slice(1);

    // Dynamic type check: 0 = Global Overlay, 1 = High-Res Viewport Chunk
    // Decode the Float16 flat array
    const decoded = decodeFloat16(payload);

    // Stride check: grid has width * height cells, with 6 stacked fields:
    // [temp, moist, windX, windY, rain, snow]
    const gridSize = this.size;
    
    // Copy slices
    this.temperature.set(decoded.subarray(0, gridSize));
    this.moisture.set(decoded.subarray(gridSize, gridSize * 2));
    this.windX.set(decoded.subarray(gridSize * 2, gridSize * 3));
    this.windY.set(decoded.subarray(gridSize * 3, gridSize * 4));
    this.rain.set(decoded.subarray(gridSize * 4, gridSize * 5));
    this.snow.set(decoded.subarray(gridSize * 5, gridSize * 6));
  }

  sendSettings(settings = {}) {
    if (!this.isConnected) return;
    
    // Update local variables if provided
    if (settings.pushRate) this.pushRate = settings.pushRate;
    if (settings.zoomedIn !== undefined) this.zoomedIn = settings.zoomedIn;
    if (settings.focusX !== undefined) this.focusX = settings.focusX;
    if (settings.focusY !== undefined) this.focusY = settings.focusY;

    const payload = {
      push_rate: this.pushRate,
      zoomed_in: this.zoomedIn,
      focus_x: this.focusX,
      focus_y: this.focusY,
      ...settings
    };
    this.ws.send(JSON.stringify(payload));
  }

  setHeightmap(img) {
    // Stub to satisfy old upload zone logic in ui.js (not used since maps are on server)
    console.log("[Client Physics] setHeightmap called. Map is maintained server-side.");
  }

  update(dt, timeOfDay, season, globalWindSpeed, globalWindAngle, globalTempShift) {
    // Stub: The simulation loop now runs on the server, not the client!
    // We send local settings tweaks over WebSockets when sliders adjust.
  }

  getWeatherAt(x, y) {
    // Convert normalized coordinate in [0, 1] to local 1k grid coordinates
    const px = Math.max(0, Math.min(this.width - 1, x * (this.width - 1)));
    const py = Math.max(0, Math.min(this.height - 1, y * (this.height - 1)));

    const x0 = Math.floor(px);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const y0 = Math.floor(py);
    const y1 = Math.min(this.height - 1, y0 + 1);

    const fx = px - x0;
    const fy = py - y0;

    const interpolateField = (field) => {
      const v00 = field[y0 * this.width + x0];
      const v10 = field[y0 * this.width + x1];
      const v01 = field[y1 * this.width + x0];
      const v11 = field[y1 * this.width + x1];

      const v0 = v00 * (1 - fx) + v10 * fx;
      const v1 = v01 * (1 - fx) + v11 * fx;
      return v0 * (1 - fy) + v1 * fy;
    };

    const altVal = interpolateField(this.heightmap);
    const tempVal = interpolateField(this.temperature);
    const moistureVal = interpolateField(this.moisture);
    const wxVal = interpolateField(this.windX);
    const wyVal = interpolateField(this.windY);
    const rainVal = interpolateField(this.rain);
    const snowVal = interpolateField(this.snow);

    // Weather condition strings
    let condition = 'Clear';
    if (rainVal > 0.05) condition = rainVal > 0.3 ? 'Heavy Rain' : 'Light Rain';
    else if (snowVal > 0.05) condition = snowVal > 0.3 ? 'Heavy Snow (Blizzard)' : 'Light Snow';
    else if (moistureVal > 0.75) condition = 'Foggy/Overcast';
    else if (moistureVal > 0.55) condition = 'Partly Cloudy';

    // Compass Direction
    const windAngleRad = Math.atan2(wxVal, -wyVal);
    let windAngle = Math.round((windAngleRad * 180) / Math.PI);
    if (windAngle < 0) windAngle += 360;

    return {
      altitude: Math.round(altVal * 3800),
      temperature: Math.round(tempVal * 10) / 10,
      moisture: Math.round(moistureVal * 100),
      pressure: 1013 - Math.round(altVal * 120), // Simulated pressure
      windSpeed: Math.round(Math.sqrt(wxVal * wxVal + wyVal * wyVal) / 0.08),
      windAngle: windAngle,
      rain: Math.round(rainVal * 100),
      snow: Math.round(snowVal * 100),
      condition: condition,
    };
  }
}
