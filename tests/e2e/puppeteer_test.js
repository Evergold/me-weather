import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--enable-features=Vulkan',
      '--enable-unsafe-swiftshader'
    ]
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.IS_PUPPETEER = true;
  });
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`BROWSER ${msg.type().toUpperCase()}: ${msg.text()}`);
    } else {
      console.log(`BROWSER LOG: ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`BROWSER PAGE ERROR: ${err.message}`);
  });

  await page.goto('http://127.0.0.1:5173');
  
  // Wait for the dashboard to launch or timeout after 30s
  try {
    await page.waitForSelector('#dashboard-screen.active', { timeout: 30000 });
    console.log("Dashboard launched successfully!");
    
    // Wait a bit to let it render
    await new Promise(r => setTimeout(r, 5000));
    
    // Take a screenshot
    await page.screenshot({ path: 'puppeteer_screenshot_webgl.png' });
    console.log("Screenshot saved.");
  } catch (e) {
    console.log("Dashboard failed to launch: " + e.message);
    await page.screenshot({ path: 'puppeteer_screenshot_webgl.png' });
    console.log("Screenshot saved anyway.");
  }

  await browser.close();
})();
