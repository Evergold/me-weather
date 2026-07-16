import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=Vulkan']
  });
  const page = await browser.newPage();
  
  await page.goto('http://127.0.0.1:5173');
  
  try {
    await page.waitForSelector('#dashboard-screen.active', { timeout: 30000 });
    console.log("Dashboard launched successfully!");
    
    // Zoom out by scrolling the mouse wheel on the canvas
    await new Promise(r => setTimeout(r, 2000));
    
    // Find the canvas element and dispatch a wheel event to zoom out
    await page.evaluate(() => {
      const canvas = document.getElementById('simulation-canvas');
      const event = new WheelEvent('wheel', {
        deltaY: 1000,
        clientX: 400,
        clientY: 300
      });
      canvas.dispatchEvent(event);
    });
    
    await new Promise(r => setTimeout(r, 2000));
    
    await page.screenshot({ path: 'zoom_test.png' });
    console.log("Zoomed out screenshot saved to zoom_test.png");
  } catch (e) {
    console.log("Dashboard failed to launch: " + e.message);
  }

  await browser.close();
})();
