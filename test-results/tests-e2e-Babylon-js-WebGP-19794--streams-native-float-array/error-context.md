# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e.spec.js >> Babylon.js WebGPU Simulation E2E Suite >> WebRTC DataChannel negotiates NAT and streams native float array
- Location: tests/e2e.spec.js:168:3

# Error details

```
Error: page.evaluate: WebRTC E2E Test timed out after 10 seconds
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e4]:
      - banner [ref=e5]:
        - generic [ref=e6]: An Arda Meteorological Model
        - heading "Middle-Earth Weather Simulator" [level=1] [ref=e7]:
          - text: Middle-Earth
          - text: Weather Simulator
      - generic [ref=e8]:
        - generic [ref=e12]: ✦
        - heading "Reading the Winds of Arda" [level=3] [ref=e13]
        - paragraph [ref=e14]: Establishing telemetry link to simulation server...
        - generic [ref=e15]: Gathering grid models & terrain dimensions
    - option "Mid-Spring (Mild, Dynamic)"
    - option "Mid-Summer (Hot, Drier)" [selected]
    - option "Mid-Autumn (Cool, Rainstorms)"
    - option "Mid-Winter (Freezing, Blizzards)"
  - generic [ref=e16]:
    - generic [ref=e17]: ⚠️
    - generic [ref=e18]: "Running in WebGL 2 Fallback Mode: High-fidelity GPU-only displacement is disabled on this device."
```

# Test source

```ts
  73  |     
  74  |     // Aggressively zoom in and out 20 times to trigger LOD tile creation/destruction
  75  |     for (let i = 0; i < 20; i++) {
  76  |       // Simulate zoom in
  77  |       await page.mouse.wheel(0, -1000);
  78  |       await page.waitForTimeout(200);
  79  |       // Simulate zoom out
  80  |       await page.mouse.wheel(0, 1000);
  81  |       await page.waitForTimeout(200);
  82  |     }
  83  |     
  84  |     // Force Garbage Collection (requires --js-flags="--expose-gc" which Playwright can pass)
  85  |     try {
  86  |       await page.evaluate(() => window.gc && window.gc());
  87  |     } catch(e) {}
  88  |     
  89  |     await page.waitForTimeout(2000);
  90  |     
  91  |     let postStressHeap = await page.evaluate(() => performance.memory.usedJSHeapSize);
  92  |     
  93  |     const heapGrowthMb = (postStressHeap - baselineHeap) / (1024 * 1024);
  94  |     console.log(`[Memory Profile] V8 Heap growth after LOD stress: ${heapGrowthMb.toFixed(2)} MB`);
  95  |     
  96  |     // Assert that we didn't leak more than 50MB of orphaned meshes/textures
  97  |     expect(heapGrowthMb).toBeLessThan(50);
  98  |   });
  99  | 
  100 |   // -------------------------------------------------------------------------
  101 |   // 4. Pixel-Perfect Visual Diffing (Glacial Shearing Validation)
  102 |   // -------------------------------------------------------------------------
  103 |   test('Glacial Shearing normal map visual regression', async ({ page }) => {
  104 |     await page.goto('/');
  105 |     
  106 |     // Wait for tiles to load and WebGPU to compile shaders
  107 |     await page.waitForTimeout(8000);
  108 |     
  109 |     // Lock the camera to a specific coordinate staring at a snow peak
  110 |     await page.evaluate(() => {
  111 |       // Assuming a global access to the engine/camera for testing
  112 |       if (window.camera) {
  113 |         window.camera.position.set(0, 1000, 0);
  114 |         window.camera.setTarget(new BABYLON.Vector3(100, 500, 100));
  115 |       }
  116 |     });
  117 | 
  118 |     // Wait for camera to settle and time to sync
  119 |     await page.waitForTimeout(1000);
  120 | 
  121 |     // Capture screenshot and compare it to the baseline image stored in the repo
  122 |     // Playwright automatically generates the baseline on the first run, and diffs on future runs
  123 |     await expect(page).toHaveScreenshot('glacial-shearing-peak.png', {
  124 |       maxDiffPixels: 100, // Allow minor anti-aliasing variations
  125 |     });
  126 |   });
  127 | 
  128 |   // -------------------------------------------------------------------------
  129 |   // 5. Multiplayer Stress Testing (AOI Bot Swarm)
  130 |   // -------------------------------------------------------------------------
  131 |   test('AOI Spatial Filtering validates under 10-bot swarm load', async ({ browser }) => {
  132 |     // For a real stress test, we'd spawn 100+, but for this E2E run we'll spawn 10
  133 |     const BOT_COUNT = 10;
  134 |     const contexts = [];
  135 |     const pages = [];
  136 |     
  137 |     for (let i = 0; i < BOT_COUNT; i++) {
  138 |       const ctx = await browser.newContext();
  139 |       const p = await ctx.newPage();
  140 |       await p.goto('/');
  141 |       contexts.push(ctx);
  142 |       pages.push(p);
  143 |     }
  144 |     
  145 |     // Wait for all bots to connect
  146 |     await Promise.all(pages.map(p => p.waitForTimeout(5000)));
  147 |     
  148 |     // In our app, ground players UI tracks WebRTC peers
  149 |     // We check the first bot's screen to see if it registers the other 9 players
  150 |     const firstBot = pages[0];
  151 |     
  152 |     // Assuming we have a UI element that says "Ground Players: 10"
  153 |     const groundPlayersUI = firstBot.locator('text=/Ground Players: \\d+/');
  154 |     const textContent = await groundPlayersUI.textContent();
  155 |     
  156 |     console.log(`[Swarm Profile] ${textContent}`);
  157 |     
  158 |     // Verify WebRTC channel successfully multiplexed the swarm
  159 |     expect(textContent).toMatch(/Ground Players: 10/);
  160 |     
  161 |     // Cleanup swarm
  162 |     await Promise.all(contexts.map(ctx => ctx.close()));
  163 |   });
  164 | 
  165 |   // -------------------------------------------------------------------------
  166 |   // 6. WebRTC Server Meshing Integration (SDP Handshake & Binary Stream)
  167 |   // -------------------------------------------------------------------------
  168 |   test('WebRTC DataChannel negotiates NAT and streams native float array', async ({ page }) => {
  169 |     // Navigate to the root (so we are on the right origin and can use WebSockets)
  170 |     await page.goto('/');
  171 | 
  172 |     // Inject a custom script to negotiate the SDP handshake directly with the Rust backend
> 173 |     const testResult = await page.evaluate(async () => {
      |                                   ^ Error: page.evaluate: WebRTC E2E Test timed out after 10 seconds
  174 |       return new Promise((resolve, reject) => {
  175 |         // Connect to the control WebSocket for signaling
  176 |         const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  177 |         const wsUrl = `${wsProto}://127.0.0.1:8000/ws/control/e2e_mesh_tester`;
  178 |         const ws = new WebSocket(wsUrl);
  179 | 
  180 |         let pc;
  181 |         let dataChannel;
  182 | 
  183 |         ws.onopen = async () => {
  184 |           // Initialize WebRTC
  185 |           pc = new RTCPeerConnection({
  186 |             iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  187 |           });
  188 | 
  189 |           // The Rust backend echoes binary data down the same DataChannel
  190 |           dataChannel = pc.createDataChannel("player_telemetry", {
  191 |             ordered: true
  192 |           });
  193 | 
  194 |           dataChannel.onopen = () => {
  195 |             // Once the DataChannel punches through, claim a physics tile!
  196 |             dataChannel.send("CLAIM");
  197 |           };
  198 | 
  199 |           dataChannel.onmessage = (event) => {
  200 |             if (event.data instanceof ArrayBuffer) {
  201 |               // We expect a 4096 Float32 array (16,384 bytes)
  202 |               if (event.data.byteLength === 16384) {
  203 |                 // Successfully received the binary grid!
  204 |                 resolve({ success: true, bytes: event.data.byteLength });
  205 |                 ws.close();
  206 |                 pc.close();
  207 |               } else {
  208 |                 reject(`Received unexpected byte length: ${event.data.byteLength}`);
  209 |               }
  210 |             }
  211 |           };
  212 | 
  213 |           // Generate Offer
  214 |           const offer = await pc.createOffer();
  215 |           await pc.setLocalDescription(offer);
  216 | 
  217 |           // Send SDP Offer to Rust Backend via WebSocket
  218 |           ws.send(JSON.stringify({
  219 |             type: "webrtc_offer",
  220 |             sdp: pc.localDescription.sdp
  221 |           }));
  222 |         };
  223 | 
  224 |         ws.onmessage = async (event) => {
  225 |           const msg = JSON.parse(event.data);
  226 |           if (msg.type === "webrtc_answer") {
  227 |             await pc.setRemoteDescription(new RTCSessionDescription({
  228 |               type: "answer",
  229 |               sdp: msg.sdp
  230 |             }));
  231 |           }
  232 |         };
  233 | 
  234 |         ws.onerror = (err) => reject("WebSocket Error: " + err);
  235 | 
  236 |         // Timeout after 10 seconds
  237 |         setTimeout(() => reject("WebRTC E2E Test timed out after 10 seconds"), 10000);
  238 |       });
  239 |     });
  240 | 
  241 |     // Assert that the WebRTC stream was successfully received
  242 |     expect(testResult.success).toBe(true);
  243 |     expect(testResult.bytes).toBe(16384);
  244 |   });
  245 | 
  246 | });
  247 | 
```