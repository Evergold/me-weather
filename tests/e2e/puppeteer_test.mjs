import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu']
  });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`BROWSER ${msg.type().toUpperCase()}: ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`BROWSER PAGE ERROR: ${err.message}`);
  });

  await page.goto('http://127.0.0.1:5173');
  
  try {
    await page.waitForSelector('#dashboard-screen.active', { timeout: 30000 });
    console.log("Dashboard launched successfully!");
    
    // Wait a bit to let it render the map
    await new Promise(r => setTimeout(r, 8000));
    
    // Take a screenshot
    await page.screenshot({ path: '/home/chuubi/Desktop/vibe-coding-2026/me-weather/puppeteer_screenshot.png' });
    console.log("Screenshot saved.");
  } catch (e) {
    console.log("Dashboard failed to launch: " + e.message);
  }

  await browser.close();
})();
