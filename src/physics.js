// physics.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

/**
 * Middle-earth Weather Simulator - Client-Side Physics Sync & Telemetry
 * Handles the WebSocket connection to the Python server, decodes binary ArrayBuffers (Float16),
 * holds local downsampled overlays/chunks, and bilinearly interpolates stats for UI hover telemetry.
 */

// Normalized Integer Mapping Decoders are built directly into unpackBinaryFrame.

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

    // WebSocket & WebRTC state
    this.clientId = 'client-' + Math.random().toString(36).substring(2, 9);
    this.controlWs = null;
    this.streamWs = null;
    this.isConnected = false;
    this.pc = null;
    this.dataChannel = null;
    this.playerPosition = { x: 0.0, y: 0.0, z: 0.0, rot: 0.0 };
    this.otherPlayers = {};
    this.playerSyncInterval = null;

    // Camera settings to push to server
    this.pushRate = '1000ms';
    this.zoomedIn = false;
    this.focusX = 0.5;
    this.focusY = 0.5;

    // Local heightmap load state
    this.isTerrainLoaded = false;
    this.weatherNeedsUpdate = false;
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
    
    // 1. Initialize Control Socket
    const controlUrl = `${wsProto}://${apiHost}/ws/control/${this.clientId}`;
    console.log(`[WebSocket Control] Connecting to ${controlUrl}...`);
    this.controlWs = new WebSocket(controlUrl);
    
    this.controlWs.onopen = () => {
      this.isConnected = true;
      console.log("[WebSocket Control] Connection established.");
      this.sendSettings();
    };
    
    this.controlWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "webrtc_answer") {
          console.log("[WebRTC] Received SDP answer from server.");
          this.handleWebRTCAnswer(msg.sdp);
        } else if (msg.type === "ground_player_count") {
          const el = document.getElementById("hud-ground-players");
          if (el) el.innerText = msg.count;
        }
      } catch (e) {
        // Not a WebRTC message or JSON parsing failed
      }
    };
    
    this.controlWs.onclose = () => {
      this.isConnected = false;
      console.log("[WebSocket Control] Connection lost. Reconnecting in 3s...");
      this.closeStreamSocket();
      this.closeWebRTC();
      setTimeout(() => this.initWebSocket(), 3000);
    };
    
    this.controlWs.onerror = (err) => {
      console.error("[WebSocket Control] Socket error:", err);
    };

    // 2. Initialize Data Stream Socket
    const streamUrl = `${wsProto}://${apiHost}/ws/stream/${this.clientId}`;
    console.log(`[WebSocket Stream] Connecting to ${streamUrl}...`);
    this.streamWs = new WebSocket(streamUrl);
    this.streamWs.binaryType = 'arraybuffer';
    
    this.streamWs.onopen = () => {
      console.log("[WebSocket Stream] Connection established.");
    };
    
    this.streamWs.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.unpackBinaryFrame(event.data);
      }
    };
    
    this.streamWs.onclose = () => {
      console.log("[WebSocket Stream] Connection lost.");
    };
    
    this.streamWs.onerror = (err) => {
      console.error("[WebSocket Stream] Socket error:", err);
    };
  }

  closeStreamSocket() {
    if (this.streamWs) {
      try {
        this.streamWs.close();
      } catch (e) {}
      this.streamWs = null;
    }
  }

  initWebRTC() {
    this.closeWebRTC();
    console.log("[WebRTC] Initializing connection...");
    
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    this.dataChannel = this.pc.createDataChannel("player_telemetry", {
      ordered: false,
      maxRetransmits: 0
    });

    this.dataChannel.onopen = () => {
      console.log("[WebRTC] Data channel established.");
      this.startPlayerSyncLoop();
    };

    this.dataChannel.onclose = () => {
      console.log("[WebRTC] Data channel closed.");
      this.stopPlayerSyncLoop();
    };

    this.dataChannel.binaryType = "arraybuffer";
    this.dataChannel.onmessage = (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          const buffer = event.data;
          const dv = new DataView(buffer);
          if (buffer.byteLength < 2) return;
          const count = dv.getUint16(0, true);
          const players = {};
          let offset = 2;
          for (let i = 0; i < count; i++) {
            if (offset + 18 > buffer.byteLength) break;
            const pid = dv.getUint16(offset, true);
            const x = dv.getFloat32(offset + 2, true);
            const y = dv.getFloat32(offset + 6, true);
            const z = dv.getFloat32(offset + 10, true);
            const rot = dv.getFloat32(offset + 14, true);
            players[pid] = {x, y, z, rot};
            offset += 18;
          }
          this.otherPlayers = players;
        }
      } catch (e) {}
    };

    this.pc.createOffer()
      .then(offer => this.pc.setLocalDescription(offer))
      .then(() => {
        if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
          console.log("[WebRTC] Sending SDP offer to server.");
          this.controlWs.send(JSON.stringify({
            type: "webrtc_offer",
            sdp: this.pc.localDescription.sdp
          }));
        }
      })
      .catch(err => console.error("[WebRTC] Error generating offer:", err));
  }

  handleWebRTCAnswer(sdp) {
    if (!this.pc) return;
    this.pc.setRemoteDescription(new RTCSessionDescription({
      type: "answer",
      sdp: sdp
    })).then(() => {
      console.log("[WebRTC] Remote description successfully set.");
    }).catch(err => console.error("[WebRTC] Failed to set remote description:", err));
  }

  startPlayerSyncLoop() {
    this.stopPlayerSyncLoop();
    this.playerSyncInterval = setInterval(() => {
      if (this.dataChannel && this.dataChannel.readyState === "open") {
        const buffer = new ArrayBuffer(16);
        const dv = new DataView(buffer);
        dv.setFloat32(0, this.playerPosition.x || 0.0, true);
        dv.setFloat32(4, this.playerPosition.y || 0.0, true);
        dv.setFloat32(8, this.playerPosition.z || 0.0, true);
        dv.setFloat32(12, this.playerPosition.rot || 0.0, true);
        this.dataChannel.send(buffer);
      }
    }, 1000 / 30); // 30 FPS
  }

  stopPlayerSyncLoop() {
    if (this.playerSyncInterval) {
      clearInterval(this.playerSyncInterval);
      this.playerSyncInterval = null;
    }
  }

  closeWebRTC() {
    this.stopPlayerSyncLoop();
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }
    this.otherPlayers = {};
  }

  enterGroundLevel() {
    console.log("[Simulation] Entering Ground-Level View...");
    this.isGroundLevel = true;
    this.initWebRTC();
  }

  exitGroundLevel() {
    console.log("[Simulation] Exiting Ground-Level View...");
    this.isGroundLevel = false;
    this.closeWebRTC();
  }

  unpackBinaryFrame(buffer) {
    try {
      const typeHeader = new Uint8Array(buffer, 0, 1)[0];
      const payload = buffer.slice(1);
      const gridSize = this.size;

      // Ordered byte offset blocks:
      // temp (uint16 * gridSize): 0 to gridSize * 2
      // moist (uint8 * gridSize): gridSize * 2 to gridSize * 3
      // windX (uint16 * gridSize): gridSize * 3 to gridSize * 5
      // windY (uint16 * gridSize): gridSize * 5 to gridSize * 7
      // rain (uint8 * gridSize): gridSize * 7 to gridSize * 8
      // snow (uint8 * gridSize): gridSize * 8 to gridSize * 9

      const tempView = new Uint16Array(payload, 0, gridSize);
      const moistView = new Uint8Array(payload, gridSize * 2, gridSize);
      const windXView = new Uint16Array(payload, gridSize * 3, gridSize);
      const windYView = new Uint16Array(payload, gridSize * 5, gridSize);
      const rainView = new Uint8Array(payload, gridSize * 7, gridSize);
      const snowView = new Uint8Array(payload, gridSize * 8, gridSize);

      // Decode normalized values back to physics floats
      for (let i = 0; i < gridSize; i++) {
        this.temperature[i] = (tempView[i] / 65535.0) * 70.0 - 20.0;
        this.moisture[i] = moistView[i] / 255.0;
        this.windX[i] = (windXView[i] / 65535.0) * 120.0 - 60.0;
        this.windY[i] = (windYView[i] / 65535.0) * 120.0 - 60.0;
        this.rain[i] = rainView[i] / 255.0;
        this.snow[i] = snowView[i] / 255.0;
      }
      this.weatherNeedsUpdate = true;
    } catch (e) {
      console.error("[Client Physics] Error unpacking binary frame:", e);
    }
  }

  sendSettings(settings = {}) {
    if (!this.isConnected || !this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) return;
    
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
    this.controlWs.send(JSON.stringify(payload));
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
