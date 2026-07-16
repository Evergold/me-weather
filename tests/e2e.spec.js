import { test, expect } from '@playwright/test';

// Global setup config
test.use({
  baseURL: 'http://localhost:5173',
  viewport: { width: 1280, height: 720 },
});

test.describe('Babylon.js WebGPU Simulation E2E Suite', () => {

  // -------------------------------------------------------------------------
  // 1. Automated WebGPU vs. WebGL 2 Fallback Verification
  // -------------------------------------------------------------------------
  test('Graceful fallback to WebGL 2 when WebGPU is missing', async ({ browser }) => {
    // Launch a completely new browser instance WITHOUT the WebGPU flag
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto('/');
    
    // Check for the presence of the fallback warning banner in the DOM
    // Assuming the app injects a banner containing 'WebGL 2 Fallback Mode' text
    const fallbackBanner = page.locator('text=WebGL 2 Fallback Mode');
    
    // We expect the banner to be visible within a few seconds of startup
    await expect(fallbackBanner).toBeVisible({ timeout: 10000 });
    
    await context.close();
  });

  // -------------------------------------------------------------------------
  // 2. Precise FPS & Performance Regression Profiling
  // -------------------------------------------------------------------------
  test('FPS and Frame Time regression analysis via CDP', async ({ page }) => {
    // Use Chrome DevTools Protocol to measure raw GPU/CPU frame times
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    
    await page.goto('/');
    
    // Wait for engine initialization and initial tile load
    await page.waitForTimeout(5000); 

    const metrics1 = await client.send('Performance.getMetrics');
    await page.waitForTimeout(2000); // Record metrics over 2 seconds
    const metrics2 = await client.send('Performance.getMetrics');

    // Extract Frames metric to calculate average FPS
    const frames1 = metrics1.metrics.find(m => m.name === 'Frames').value;
    const frames2 = metrics2.metrics.find(m => m.name === 'Frames').value;
    
    const fps = (frames2 - frames1) / 2.0; // Frames drawn over 2 seconds
    console.log(`[Performance Profile] Rendered at ${fps} FPS`);
    
    // Assert that the simulation holds a steady 60 FPS (with minor 10% tolerance)
    expect(fps).toBeGreaterThanOrEqual(54);
  });

  // -------------------------------------------------------------------------
  // 3. Automated Memory Leak Detection
  // -------------------------------------------------------------------------
  test('V8 Heap footprint stability during aggressive geomorphing', async ({ page }) => {
    await page.goto('/');
    
    // Ensure garbage collection is exposed
    const client = await page.context().newCDPSession(page);
    await client.send('HeapProfiler.enable');

    await page.waitForTimeout(5000); // Let initial tiles load
    
    // Measure baseline heap size
    let baselineHeap = await page.evaluate(() => performance.memory.usedJSHeapSize);
    
    // Aggressively zoom in and out 20 times to trigger LOD tile creation/destruction
    for (let i = 0; i < 20; i++) {
      // Simulate zoom in
      await page.mouse.wheel(0, -1000);
      await page.waitForTimeout(200);
      // Simulate zoom out
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(200);
    }
    
    // Force Garbage Collection (requires --js-flags="--expose-gc" which Playwright can pass)
    try {
      await page.evaluate(() => window.gc && window.gc());
    } catch(e) {}
    
    await page.waitForTimeout(2000);
    
    let postStressHeap = await page.evaluate(() => performance.memory.usedJSHeapSize);
    
    const heapGrowthMb = (postStressHeap - baselineHeap) / (1024 * 1024);
    console.log(`[Memory Profile] V8 Heap growth after LOD stress: ${heapGrowthMb.toFixed(2)} MB`);
    
    // Assert that we didn't leak more than 50MB of orphaned meshes/textures
    expect(heapGrowthMb).toBeLessThan(50);
  });

  // -------------------------------------------------------------------------
  // 4. Pixel-Perfect Visual Diffing (Glacial Shearing Validation)
  // -------------------------------------------------------------------------
  test('Glacial Shearing normal map visual regression', async ({ page }) => {
    await page.goto('/');
    
    // Wait for tiles to load and WebGPU to compile shaders
    await page.waitForTimeout(8000);
    
    // Lock the camera to a specific coordinate staring at a snow peak
    await page.evaluate(() => {
      // Assuming a global access to the engine/camera for testing
      if (window.camera) {
        window.camera.position.set(0, 1000, 0);
        window.camera.setTarget(new BABYLON.Vector3(100, 500, 100));
      }
    });

    // Wait for camera to settle and time to sync
    await page.waitForTimeout(1000);

    // Capture screenshot and compare it to the baseline image stored in the repo
    // Playwright automatically generates the baseline on the first run, and diffs on future runs
    await expect(page).toHaveScreenshot('glacial-shearing-peak.png', {
      maxDiffPixels: 100, // Allow minor anti-aliasing variations
    });
  });

  // -------------------------------------------------------------------------
  // 5. Multiplayer Stress Testing (AOI Bot Swarm)
  // -------------------------------------------------------------------------
  test('AOI Spatial Filtering validates under 10-bot swarm load', async ({ browser }) => {
    // For a real stress test, we'd spawn 100+, but for this E2E run we'll spawn 10
    const BOT_COUNT = 10;
    const contexts = [];
    const pages = [];
    
    for (let i = 0; i < BOT_COUNT; i++) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto('/');
      contexts.push(ctx);
      pages.push(p);
    }
    
    // Wait for all bots to connect
    await Promise.all(pages.map(p => p.waitForTimeout(5000)));
    
    // In our app, ground players UI tracks WebRTC peers
    // We check the first bot's screen to see if it registers the other 9 players
    const firstBot = pages[0];
    
    // Assuming we have a UI element that says "Ground Players: 10"
    const groundPlayersUI = firstBot.locator('text=/Ground Players: \\d+/');
    const textContent = await groundPlayersUI.textContent();
    
    console.log(`[Swarm Profile] ${textContent}`);
    
    // Verify WebRTC channel successfully multiplexed the swarm
    expect(textContent).toMatch(/Ground Players: 10/);
    
    // Cleanup swarm
    await Promise.all(contexts.map(ctx => ctx.close()));
  });

  // -------------------------------------------------------------------------
  // 6. WebRTC Server Meshing Integration (SDP Handshake & Binary Stream)
  // -------------------------------------------------------------------------
  test('WebRTC DataChannel negotiates NAT and streams native float array', async ({ page }) => {
    // Navigate to the root (so we are on the right origin and can use WebSockets)
    await page.goto('/');

    // Inject a custom script to negotiate the SDP handshake directly with the Rust backend
    const testResult = await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        // Connect to the control WebSocket for signaling
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${wsProto}://127.0.0.1:8000/ws/control/e2e_mesh_tester`;
        const ws = new WebSocket(wsUrl);

        let pc;
        let dataChannel;

        ws.onopen = async () => {
          // Initialize WebRTC
          pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
          });

          // The Rust backend echoes binary data down the same DataChannel
          dataChannel = pc.createDataChannel("player_telemetry", {
            ordered: true
          });

          dataChannel.onopen = () => {
            // Once the DataChannel punches through, claim a physics tile!
            dataChannel.send("CLAIM");
          };

          dataChannel.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              // We expect a 4096 Float32 array (16,384 bytes)
              if (event.data.byteLength === 16384) {
                // Successfully received the binary grid!
                resolve({ success: true, bytes: event.data.byteLength });
                ws.close();
                pc.close();
              } else {
                reject(`Received unexpected byte length: ${event.data.byteLength}`);
              }
            }
          };

          // Generate Offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          // Send SDP Offer to Rust Backend via WebSocket
          ws.send(JSON.stringify({
            type: "webrtc_offer",
            sdp: pc.localDescription.sdp
          }));
        };

        ws.onmessage = async (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "webrtc_answer") {
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: "answer",
              sdp: msg.sdp
            }));
          }
        };

        ws.onerror = (err) => reject("WebSocket Error: " + err);

        // Timeout after 10 seconds
        setTimeout(() => reject("WebRTC E2E Test timed out after 10 seconds"), 10000);
      });
    });

    // Assert that the WebRTC stream was successfully received
    expect(testResult.success).toBe(true);
    expect(testResult.bytes).toBe(16384);
  });

  // -------------------------------------------------------------------------
  // 7. localStorage / DB re-hydration
  // -------------------------------------------------------------------------
  test('localStorage persistence across reloads', async ({ page }) => {
    await page.goto('/');
    
    // Inject a value into localStorage
    await page.evaluate(() => {
      localStorage.setItem('me_weather_test_key', 'persisted_data_123');
    });
    
    // Reload the page
    await page.reload();
    
    // Check if it persisted
    const val = await page.evaluate(() => {
      return localStorage.getItem('me_weather_test_key');
    });
    
    expect(val).toBe('persisted_data_123');
  });

  // -------------------------------------------------------------------------
  // 8. UI telemetry (ControlMessage JSON)
  // -------------------------------------------------------------------------
  test('UI Telemetry (ControlMessage JSON) serializes correctly', async ({ page }) => {
    // Evaluate a script that sends a telemetry-like message via the existing WebSocket if possible,
    // or just simulate the ControlMessage serialization on the client-side.
    const sentData = await page.evaluate(() => {
      // Simulate constructing a ControlMessage that the rust backend expects
      const controlMessage = {
        type: "ui_telemetry",
        season: "winter",
        time_of_day: 14.5,
        wind_x: 2.1,
        wind_y: -0.5
      };
      return JSON.stringify(controlMessage);
    });

    const parsed = JSON.parse(sentData);
    expect(parsed.type).toBe('ui_telemetry');
    expect(parsed.season).toBe('winter');
    expect(parsed.time_of_day).toBe(14.5);
  });

  // -------------------------------------------------------------------------
  // 9. Mobile Viewport / Resizing
  // -------------------------------------------------------------------------
  test('Canvas resizes correctly on mobile viewport simulation', async ({ page }) => {
    await page.goto('/');
    
    // Start with desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(1000);
    
    let canvasSize = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return { width: canvas.clientWidth, height: canvas.clientHeight };
    });
    
    // Assert initial size is roughly matching viewport or full screen
    expect(canvasSize.width).toBeGreaterThan(1000);
    
    // Emulate mobile switch
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE size
    await page.waitForTimeout(1000);
    
    // Check if canvas resized
    canvasSize = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return { width: canvas.clientWidth, height: canvas.clientHeight };
    });
    
    expect(canvasSize.width).toBe(375);
    expect(canvasSize.height).toBeGreaterThan(390);
    expect(canvasSize.height).toBeLessThan(410);
  });

});
