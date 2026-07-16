import puppeteer from 'puppeteer';
import fs from 'fs';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan'
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
  
  await page.screenshot({ path: 'puppeteer_screenshot.png', fullPage: true });
  
  fs.writeFileSync('browser_logs.txt', logs.join('\n'));
  console.log("Logs written to browser_logs.txt");
  
  await browser.close();
})();
