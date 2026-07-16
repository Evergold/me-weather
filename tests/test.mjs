import puppeteer from 'puppeteer';
import fs from 'fs';

async function runTest(engineType) {
    console.log(`Starting Puppeteer test for ${engineType}...`);
    const args = ['--no-sandbox', '--disable-setuid-sandbox'];
    
    let headlessMode = "new";
    if (engineType === 'webgpu') {
        args.push('--enable-unsafe-webgpu');
        // WebGPU crashes on captureScreenshot in headless: new, so we use xvfb
        headlessMode = false;
    }
    
    const browser = await puppeteer.launch({ headless: headlessMode, args });
    const page = await browser.newPage();
    
    await page.setViewport({ width: 1280, height: 720 });
    
    await page.evaluateOnNewDocument((engine) => {
        window.localStorage.setItem('preferredEngine', engine);
    }, engineType);

    page.on('console', msg => {
        console.log(`[${engineType}][${msg.type()}] ${msg.text()}`);
    });
    
    page.on('pageerror', error => {
        console.log(`[${engineType}][PAGE ERROR] ${error.message}`);
    });

    try {
        await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[${engineType}] Page loaded. Waiting for dashboard to activate...`);
        
        await page.waitForSelector('#dashboard-screen.active', { timeout: 40000 });
        console.log(`[${engineType}] Dashboard active! Waiting 5 more seconds for terrain shaders to finish compiling...`);
        await new Promise(r => setTimeout(r, 5000));
        
        await page.screenshot({ path: `/home/chuubi/.gemini/antigravity-cli/brain/9242c686-bded-41b8-8f18-8d7fa8dace32/puppeteer_${engineType}.png` });
        console.log(`[${engineType}] Screenshot saved.`);
    } catch (e) {
        console.error(`[${engineType}] Error: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    const dir = '/home/chuubi/.gemini/antigravity-cli/brain/9242c686-bded-41b8-8f18-8d7fa8dace32';
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    await runTest('webgpu');
    await runTest('webgl');
}

main();
