'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const [,, pdfPath, outDir] = process.argv;
if (!pdfPath) { console.error('Usage: node rasterize.js <pdf> <outDir>'); process.exit(1); }

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 850, height: 1100 });

  const absPath = path.resolve(pdfPath);
  await page.goto('file://' + absPath, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2000));

  const outPath = path.join(outDir || path.dirname(absPath), path.basename(pdfPath, '.pdf') + '-p1.png');
  await page.screenshot({ path: outPath, fullPage: false });
  console.log('Saved:', outPath);
  await browser.close();
})();
