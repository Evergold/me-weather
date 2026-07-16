import puppeteer from 'puppeteer';

async function main() {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu'] });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log(msg.text()));

    await page.evaluate(async () => {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.log("No WebGPU adapter found.");
                return;
            }
            const device = await adapter.requestDevice();
            console.log("WebGPU Device Limits:");
            for (let key in device.limits) {
                console.log(`${key}: ${device.limits[key]}`);
            }
        } catch(e) {
            console.log("Error:", e.message);
        }
    });

    await browser.close();
}

main();
