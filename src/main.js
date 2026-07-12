// main.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

/**
 * Middle-earth Weather Simulator - Main Entry Point
 * Coordinates the Physics grid updates, Canvas rendering, and UI event systems.
 */

import { WeatherPhysics } from './physics.js';
import { WeatherRenderer } from './renderer.js';
import { WeatherUI } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('simulation-canvas');
  
  // 1. Initialize core sub-systems
  const physics = new WeatherPhysics(256, 256);
  const renderer = new WeatherRenderer(canvas);
  let ui = null;

  let lastTime = performance.now();
  let animationFrameId = null;
  let frameCount = 0;

  // 2. Main Simulation Animation Loop
  function tick(timestamp) {
    // Calculate delta time in seconds, cap to prevent giant jumps
    let dt = (timestamp - lastTime) / 1000.0;
    if (dt > 0.1) dt = 0.1; // cap frame jumps
    lastTime = timestamp;

    if (ui && ui.simSpeed > 0) {
      // Advance time of day
      ui.advanceTime(dt);

      // Run physics simulation step
      // Scaled by time multiplier
      physics.update(
        dt * ui.simSpeed,
        ui.timeOfDay,
        ui.season,
        ui.globalWindSpeed,
        ui.globalWindAngle,
        ui.globalTempShift
      );

      // Periodically refresh the sidebar watchlist weather telemetry (every 12 frames)
      frameCount++;
      if (frameCount % 12 === 0) {
        ui.renderLandmarksList();
      }
    }

    // Render current frame
    if (ui) {
      const landmarksList = ui.landmarkManager.getAll();
      const updatedLandmarks = ui.landmarkManager.updateLandmarkWeather(physics);

      renderer.draw(
        physics,
        ui.activeLayer,
        ui.toggleWind,
        ui.toggleWeather,
        ui.toggleLandmarks,
        updatedLandmarks,
        ui.selectedLandmarkId,
        ui.timeOfDay
      );
    }

    animationFrameId = requestAnimationFrame(tick);
  }

  // Wrapper function to begin/resume animation loop
  function startSimulationLoop() {
    if (!animationFrameId) {
      lastTime = performance.now();
      animationFrameId = requestAnimationFrame(tick);
    }
  }

  // 3. Initialize UI controller and bind loop callback
  ui = new WeatherUI(physics, renderer, startSimulationLoop);
});
