/**
 * Middle-earth Weather Physics Engine
 * Simulates temperature, pressure, wind vectors, humidity, and precipitation
 * on a discrete 2D grid based on elevation data.
 */

export class WeatherPhysics {
  constructor(gridWidth = 128, gridHeight = 128) {
    this.width = gridWidth;
    this.height = gridHeight;
    this.size = gridWidth * gridHeight;

    // Simulation Grids (flat arrays for performance)
    this.heightmap = new Float32Array(this.size);
    this.temperature = new Float32Array(this.size);
    this.pressure = new Float32Array(this.size);
    this.moisture = new Float32Array(this.size);
    this.windX = new Float32Array(this.size);
    this.windY = new Float32Array(this.size);
    this.rain = new Float32Array(this.size);
    this.snow = new Float32Array(this.size);

    // Evaporation mask (1 where there is sea, 0 on land)
    this.isWater = new Uint8Array(this.size);

    // Temporary buffer for advection
    this.tempBuffer = new Float32Array(this.size);
  }

  /**
   * Initializes the heightmap grid from an HTMLImageElement.
   * Grayscale values (R channel) are mapped to height [0, 1].
   */
  setHeightmap(image) {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, this.width, this.height);

    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    const data = imgData.data;

    for (let i = 0; i < this.size; i++) {
      const r = data[i * 4]; // grayscale image red channel
      const heightVal = r / 255.0;
      this.heightmap[i] = heightVal;

      // Define water (sea level is height < 0.08 in grayscale)
      // Usually, ocean is dark/black in heightmaps.
      this.isWater[i] = heightVal < 0.08 ? 1 : 0;

      // Initialize physical fields
      this.moisture[i] = this.isWater[i] ? 0.9 : 0.4;
      this.temperature[i] = 15;
      this.pressure[i] = 1013;
      this.windX[i] = 0;
      this.windY[i] = 0;
      this.rain[i] = 0;
      this.snow[i] = 0;
    }

    // Run a few pre-warm cycles to initialize moisture and temperature states
    for (let j = 0; j < 50; j++) {
      this.update(0.1, 480, 'summer', 15, 270, 0); // 8:00 AM summer defaults
    }
  }

  /**
   * Main Physics Update Tick
   * @param {number} dt Time step delta
   * @param {number} timeOfDay Current minute of the day (0 - 1439)
   * @param {string} season 'spring' | 'summer' | 'autumn' | 'winter'
   * @param {number} globalWindSpeed Base wind speed in knots
   * @param {number} globalWindAngle Base wind direction in degrees (0 = North, 90 = East, etc.)
   * @param {number} globalTempShift Offset to temperature slider value
   */
  update(dt, timeOfDay, season, globalWindSpeed, globalWindAngle, globalTempShift) {
    // 1. Calculate base solar heating & seasonal temperatures
    const solarIntensity = this.getSolarIntensity(timeOfDay);
    const seasonBaseTemp = this.getSeasonBaseTemp(season) + globalTempShift;

    // Convert global wind speed & angle to vector components
    // angle is degrees: 0 = North, 90 = East, 180 = South, 270 = West
    const rad = (globalWindAngle * Math.PI) / 180;
    const globalWindVX = Math.sin(rad) * (globalWindSpeed * 0.08);
    const globalWindVY = -Math.cos(rad) * (globalWindSpeed * 0.08); // Y-axis goes down in grid coordinate space

    // 2. Compute Temperature and Pressure fields
    for (let y = 0; y < this.height; y++) {
      // Latitude effect: Northern Middle-earth (y=0) is colder, Southern (y=H) is warmer.
      const latFactor = (y / this.height) * 20 - 8; // -8°C (North) to +12°C (South)

      for (let x = 0; x < this.width; x++) {
        const idx = y * this.width + x;
        const height = this.heightmap[idx];

        // Temperature calculation:
        // Temp = base season temp + latitude shift - altitude cooling (height * 30°C lapse rate) + solar warming
        // Solar warming is reduced by altitude slightly, but mostly depends on solar intensity
        const lapseRate = height * 28; // height [0,1] maps to up to 28°C cooling (high mountains are freezing)
        const solarWarming = solarIntensity * (15 - height * 5); // solar heating adds up to 15°C
        
        let temp = seasonBaseTemp + latFactor - lapseRate + solarWarming;

        // Custom localized geothermal heating (e.g., Mount Doom/Mordor area is naturally hotter if we knew coordinates,
        // but let's keep it purely physical here: high altitude is cold, low altitude is warm).
        this.temperature[idx] = temp;

        // Pressure calculation:
        // Base atmospheric pressure drops with height.
        // Heat creates localized low-pressure systems (air expands and rises).
        // Cold creates high-pressure systems.
        const elevationPressureDrop = height * 120; // drop up to 120 hPa at high mountains
        const thermalPressureShift = (temp - 15) * -1.5; // warm temp = lower pressure
        
        this.pressure[idx] = 1013 - elevationPressureDrop + thermalPressureShift;
      }
    }

    // 3. Compute Wind Vector Field (Pressure Gradient Force + Coriolis + Mountain Blocking)
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        const idx = y * this.width + x;

        // Pressure gradients
        const dpdx = (this.pressure[idx + 1] - this.pressure[idx - 1]) / 2;
        const dpdy = (this.pressure[idx + this.width] - this.pressure[idx - this.width]) / 2;

        // Wind acceleration proportional to pressure gradient (from high to low pressure, so negative sign)
        let vx = -dpdx * 0.15;
        let vy = -dpdy * 0.15;

        // Coriolis effect (deflects wind: in Northern Hemisphere, deflects to the right)
        // Deflect proportional to latitude (Coriolis increases towards poles - in our map, north is top, so y=0 is pole)
        const coriolisFactor = 0.08 * (1.0 - y / this.height);
        const corX = vy * coriolisFactor;
        const corY = -vx * coriolisFactor;
        vx += corX;
        vy += corY;

        // Add global atmospheric steering wind
        vx += globalWindVX;
        vy += globalWindVY;

        // Mountain Blocking & Friction
        // If there's a steep height increase in the direction of the wind, the wind is blocked/deflected.
        const h = this.heightmap[idx];
        const hRight = this.heightmap[idx + 1];
        const hLeft = this.heightmap[idx - 1];
        const hDown = this.heightmap[idx + this.width];
        const hUp = this.heightmap[idx - this.width];

        // Height gradient along the wind direction
        const gradX = vx > 0 ? (hRight - h) : (h - hLeft);
        const gradY = vy > 0 ? (hDown - h) : (h - hUp);

        // Block wind if climbing a steep slope
        if (gradX > 0) vx *= Math.max(0.05, 1.0 - gradX * 8.0);
        if (gradY > 0) vy *= Math.max(0.05, 1.0 - gradY * 8.0);

        // Add deflection around mountains (wind flows around rather than straight through)
        // If wind hits a mountain, split its energy into the perpendicular direction of lowest gradient
        const slopeX = hRight - hLeft;
        const slopeY = hDown - hUp;
        
        // Deflect wind along slope contour line (tangent)
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > 0.1 && (Math.abs(slopeX) > 0.05 || Math.abs(slopeY) > 0.05)) {
          // contour tangent is (-slopeY, slopeX)
          const tx = -slopeY;
          const ty = slopeX;
          const len = Math.sqrt(tx * tx + ty * ty);
          if (len > 0.001) {
            const dot = (vx * tx + vy * ty) / (speed * len);
            // Blend original wind with deflected wind along terrain contours
            const blend = 0.5 * Math.min(1.0, (Math.abs(slopeX) + Math.abs(slopeY)) * 4.0);
            vx = vx * (1 - blend) + (tx / len) * speed * dot * blend;
            vy = vy * (1 - blend) + (ty / len) * speed * dot * blend;
          }
        }

        this.windX[idx] = vx;
        this.windY[idx] = vy;
      }
    }

    // Bound edges for wind vectors
    this.handleEdges(this.windX, 0);
    this.handleEdges(this.windY, 0);

    // 4. Moisture Evaporation & Atmospheric Advection
    // Evaporation: Oceans replenish moisture. Hotter temperature increases evaporation rate.
    for (let i = 0; i < this.size; i++) {
      if (this.isWater[i]) {
        const temp = this.temperature[i];
        const evapRate = Math.max(0.01, (temp + 10) * 0.015) * dt;
        this.moisture[i] = Math.min(1.0, this.moisture[i] + evapRate);
      }
    }

    // Advection: Move moisture along the wind vector field (using simple semi-Lagrangian backtrace)
    this.advect(this.moisture, this.windX, this.windY, dt);

    // 5. Precipitation Simulation (Rain, Snow, Orographic Lift, and Condensation)
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        const idx = y * this.width + x;
        const h = this.heightmap[idx];
        const temp = this.temperature[idx];
        const moist = this.moisture[idx];
        const vx = this.windX[idx];
        const vy = this.windY[idx];

        // Orographic Lift: Wind blowing up a slope causes forced rising of air
        // We look at the change in terrain height along the wind vector
        const idxNextX = idx + Math.sign(vx);
        const idxNextY = idx + Math.sign(vy) * this.width;
        const hNextX = this.heightmap[idxNextX];
        const hNextY = this.heightmap[idxNextY];
        
        // Height increase in wind direction
        const deltaHX = vx * (hNextX - h);
        const deltaHY = vy * (hNextY - h);
        const lift = Math.max(0, deltaHX + deltaHY) * 1.5; // positive means forced ascent

        // Humidity saturation threshold decreases with temperature (cold air holds less moisture)
        // Saturation threshold: e.g. 0.9 at 30°C, 0.4 at -10°C
        const saturationThreshold = Math.max(0.35, 0.6 + (temp - 10) * 0.015);

        let precipitationRate = 0;

        // If local humidity exceeds saturation, or if we have strong orographic lift pushing moist air up
        if (moist > saturationThreshold) {
          const excessMoist = moist - saturationThreshold;
          precipitationRate = excessMoist * 0.4 + lift * moist * 0.5;
        } else if (lift > 0.02 && moist > 0.4) {
          // Orographic lift can cause rain even if local ambient moisture is not fully saturated
          precipitationRate = lift * moist * 0.4;
        }

        // Apply temperature threshold to decide between rain & snow
        // Trans-freezing buffer zone [ -1.5°C, 1.5°C ] for mixing, but simple cutoff works great for simulation
        if (precipitationRate > 0.01) {
          precipitationRate = Math.min(1.0, precipitationRate * dt * 5.0); // scale rate
          
          if (temp < 0.5) {
            this.snow[idx] = precipitationRate;
            this.rain[idx] = 0;
          } else {
            this.rain[idx] = precipitationRate;
            this.snow[idx] = 0;
          }

          // Consume moisture due to precipitation rainout
          this.moisture[idx] = Math.max(0.05, moist - precipitationRate * 0.8);
        } else {
          this.rain[idx] = 0;
          this.snow[idx] = 0;

          // Natural dry-air recovery: land slowly loses moisture without ocean source or rain
          if (!this.isWater[idx]) {
            this.moisture[idx] = Math.max(0.1, moist - 0.015 * dt);
          }
        }
      }
    }

    // Smooth field boundaries
    this.handleEdges(this.moisture, 0.4);
    this.handleEdges(this.rain, 0);
    this.handleEdges(this.snow, 0);
  }

  /**
   * Semi-Lagrangian Advection
   * Moves a scalar field (like moisture) along the wind velocity field.
   */
  advect(field, vx, vy, dt) {
    const w = this.width;
    const h = this.height;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;

        // Trace backward in time
        // scale velocities to grid space
        const prevX = x - vx[idx] * dt * 15;
        const prevY = y - vy[idx] * dt * 15;

        // Clamp to boundaries
        const px = Math.max(0.5, Math.min(w - 1.5, prevX));
        const py = Math.max(0.5, Math.min(h - 1.5, prevY));

        // Bilinear interpolation of the four surrounding grid cells
        const x0 = Math.floor(px);
        const x1 = x0 + 1;
        const y0 = Math.floor(py);
        const y1 = y0 + 1;

        const fx = px - x0;
        const fy = py - y0;

        const idx00 = y0 * w + x0;
        const idx10 = y0 * w + x1;
        const idx01 = y1 * w + x0;
        const idx11 = y1 * w + x1;

        const val00 = field[idx00];
        const val10 = field[idx10];
        const val01 = field[idx01];
        const val11 = field[idx11];

        // Interpolate
        const val0 = val00 * (1 - fx) + val10 * fx;
        const val1 = val01 * (1 - fx) + val11 * fx;
        this.tempBuffer[idx] = val0 * (1 - fy) + val1 * fy;
      }
    }

    // Copy buffer back to field
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        field[idx] = this.tempBuffer[idx];
      }
    }
  }

  /**
   * Extrapolates boundary conditions on the grid edges
   */
  handleEdges(field, fallbackValue) {
    const w = this.width;
    const h = this.height;

    // Top and bottom edges
    for (let x = 0; x < w; x++) {
      field[x] = field[w + x];
      field[(h - 1) * w + x] = field[(h - 2) * w + x];
    }
    // Left and right edges
    for (let y = 0; y < h; y++) {
      field[y * w] = field[y * w + 1];
      field[y * w + (w - 1)] = field[y * w + (w - 2)];
    }
    // Corners
    field[0] = (field[1] + field[w]) / 2;
    field[w - 1] = (field[w - 2] + field[2 * w - 1]) / 2;
    field[(h - 1) * w] = (field[(h - 2) * w] + field[(h - 1) * w + 1]) / 2;
    field[h * w - 1] = (field[h * w - 2] + field[(h - 1) * w - 1]) / 2;
  }

  /**
   * Helper: Solar intensity based on minutes past midnight.
   * Peaks at solar noon (720 min = 12:00), minimum at night.
   */
  getSolarIntensity(timeOfDay) {
    // 720 minutes is 12:00 PM.
    // solar cycle ranges from 0 (night) to 1 (noon)
    // Shifted so peak is at noon, and it's dark before 6 AM and after 6 PM.
    const hour = timeOfDay / 60;
    const dayFactor = Math.sin((hour - 6) * Math.PI / 12); // -1 to 1
    return Math.max(0, dayFactor);
  }

  /**
   * Helper: Base ambient temperature for a given season.
   */
  getSeasonBaseTemp(season) {
    switch (season) {
      case 'spring': return 12; // Mild
      case 'summer': return 25; // Warm
      case 'autumn': return 8;  // Cool
      case 'winter': return -5; // Freezing
      default: return 12;
    }
  }

  /**
   * Bilinearly interpolates physical fields for high-res hover inspection.
   * Coordinate inputs x and y are in range [0, 1].
   */
  getWeatherAt(x, y) {
    // Convert normalized [0, 1] coordinates to grid coordinates [0, W-1] and [0, H-1]
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
    const pressVal = interpolateField(this.pressure);
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

    // Altitude in meters: heightmap [0, 1] maps to e.g. 0m to 4000m (Caradhras is ~3500m-4000m equivalent)
    const altitudeMeters = Math.round(altVal * 3800);

    // Wind speed: magnitude of (wx, wy) vector, scaled to knots
    // wind components were scaled by 0.08 of knots, let's back-calculate knots
    const windKnots = Math.round(Math.sqrt(wxVal * wxVal + wyVal * wyVal) / 0.08);

    // Wind angle
    let windAngle = Math.round((Math.atan2(wxVal, -wyVal) * 180) / Math.PI);
    if (windAngle < 0) windAngle += 360;

    return {
      altitude: altitudeMeters,
      temperature: Math.round(tempVal * 10) / 10,
      moisture: Math.round(moistureVal * 100),
      pressure: Math.round(pressVal),
      windSpeed: windKnots,
      windAngle: windAngle,
      rain: Math.round(rainVal * 100),
      snow: Math.round(snowVal * 100),
      condition: condition,
    };
  }
}
