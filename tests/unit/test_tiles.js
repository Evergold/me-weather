import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=Vulkan']
  });
  const page = await browser.newPage();
  
  // Intercept console messages
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  
  await page.goto('http://127.0.0.1:5173');
  
  try {
    await page.waitForSelector('#dashboard-screen.active', { timeout: 30000 });
    
    // Evaluate and print active tiles
    const activeTiles = await page.evaluate(() => {
      const keys = Array.from(window.app.renderer.terrain.activeTiles.keys());
      const z = window.app.renderer.terrain.currentZoom;
      const r = window.app.renderer.camera.radius;
      return { keys, z, r };
    });
    console.log("Before zoom out:", activeTiles);
    
    await page.evaluate(() => {
      const canvas = document.getElementById('simulation-canvas');
      const event = new WheelEvent('wheel', { deltaY: 2000, clientX: 400, clientY: 300 });
      canvas.dispatchEvent(event);
    });
    
    await new Promise(r => setTimeout(r, 2000));
    
    const activeTiles2 = await page.evaluate(() => {
      const keys = Array.from(window.app.renderer.terrain.activeTiles.keys());
      const z = window.app.renderer.terrain.currentZoom;
      const r = window.app.renderer.camera.radius;
      return { keys, z, r };
    });
    console.log("After zoom out:", activeTiles2);
    
  } catch (e) {
    console.log("Error:", e);
  }

  await browser.close();
})();
