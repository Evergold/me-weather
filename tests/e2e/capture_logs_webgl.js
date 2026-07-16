import puppeteer from 'puppeteer';
import fs from 'fs';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
      // Omitted --enable-unsafe-webgpu to force WebGL2 fallback
    ]
  });
  
  const page = await browser.newPage();
  const logs = [];
  
  page.on('console', msg => logs.push(`BROWSER LOG [${msg.type()}]: ${msg.text()}`));
  page.on('pageerror', err => logs.push(`BROWSER PAGE ERROR: ${err.message}`));
  
  try {
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle2', timeout: 15000 });
  } catch (e) {
    logs.push(`GOTO ERROR: ${e.message}`);
  }
  
  await new Promise(r => setTimeout(r, 20000));
  
  await page.screenshot({ path: 'puppeteer_screenshot_webgl.png', fullPage: true });
  
  fs.writeFileSync('browser_logs_webgl.txt', logs.join('\n'));
  console.log("Logs written to browser_logs_webgl.txt");
  
  await browser.close();
})();
