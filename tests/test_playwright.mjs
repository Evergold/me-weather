import { chromium } from 'playwright';
import fs from 'fs';

async function runTest(engineType) {
    console.log(`Starting Playwright test for ${engineType}...`);
    const args = ['--no-sandbox'];
    if (engineType === 'webgpu') {
        args.push('--enable-unsafe-webgpu');
    }
    
    const browser = await chromium.launch({ headless: true, args });
    const context = await browser.newContext();
    
    await context.addInitScript((engine) => {
        window.localStorage.setItem('preferredEngine', engine);
    }, engineType);
    
    const page = await context.newPage();

    page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            console.log(`[${engineType}][${msg.type()}] ${msg.text()}`);
        }
    });

    try {
        await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[${engineType}] Page loaded. Waiting 10 seconds for terrain to render...`);
        await new Promise(r => setTimeout(r, 10000));
        
        if (engineType === 'webgpu') {
            console.log(`[${engineType}] Bypassing native page.screenshot() to avoid Lavapipe readback crashes...`);
            const b64 = await page.evaluate(() => {
                return new Promise((resolve) => {
                    const r = window.__WEATHER_RENDERER;
                    if (!r || !r.engine || !r.camera) return resolve(null);
                    r.engine.onEndFrameObservable.addOnce(() => {
                        window.BABYLON.Tools.CreateScreenshotUsingRenderTarget(r.engine, r.camera, { width: 1920, height: 1080 }, function (data) {
                            resolve(data);
                        });
                    });
                });
            });
            if (b64) {
                const buffer = Buffer.from(b64.split(',')[1], 'base64');
                fs.writeFileSync(`../scratch/playwright_${engineType}.png`, buffer);
            }
        } else {
            await page.screenshot({ path: `../scratch/playwright_${engineType}.png` });
        }
        console.log(`[${engineType}] Screenshot saved.`);
    } catch (e) {
        console.error(`[${engineType}] Error: ${e.message}`);
    } finally {
        await browser.close();
    }
}

async function main() {
    if (!fs.existsSync('../scratch')) {
        fs.mkdirSync('../scratch');
    }
    await runTest('webgl');
}

main();
