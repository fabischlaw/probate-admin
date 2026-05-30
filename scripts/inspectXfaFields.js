const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function inspectForm(formPath, screenshotPath) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  const absolutePath = path.resolve(formPath);
  await page.goto('file://' + absolutePath, {
    waitUntil: 'networkidle0',
    timeout: 30000
  });

  // Wait for XFA to render
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Extract all XFA field names, types, and any current values
  const fields = await page.evaluate(() => {
    const results = [];

    // Try standard PDF.js / XFA field detection
    const inputs = document.querySelectorAll(
      'input, textarea, select, [role="textbox"], [role="combobox"], ' +
      '[role="checkbox"], [role="radio"], [data-field-name]'
    );

    inputs.forEach(el => {
      results.push({
        tag: el.tagName,
        type: el.type || el.getAttribute('role') || 'unknown',
        name: el.name || el.id || el.getAttribute('data-field-name') ||
              el.getAttribute('aria-label') || 'unnamed',
        value: el.value || el.textContent?.trim() || '',
        placeholder: el.placeholder || ''
      });
    });

    return results;
  });

  // Also grab page title and any form metadata
  const title = await page.title();
  const url = page.url();

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('  Screenshot saved to ' + screenshotPath);
  }

  await browser.close();

  return { formPath, title, url, fieldCount: fields.length, fields };
}

async function main() {
  const forms = [
    './ma-templates/MPC-150.pdf',
    './ma-templates/MPC-162.pdf',
    './ma-templates/MPC-163.pdf',
    './ma-templates/MPC-160.pdf',
    './ma-templates/MPC-161.pdf',
    './ma-templates/MPC-170.pdf',
    './ma-templates/MPC-455.pdf',
    './ma-templates/MPC-470.pdf',
    './ma-templates/MPC-475.pdf',
    './ma-templates/MPC-480.pdf',
    './ma-templates/MPC-485.pdf',
    './ma-templates/MPC-550.pdf',
    './ma-templates/MPC-751.pdf',
    './ma-templates/MPC-750.pdf',
    './ma-templates/MPC-755.pdf',
    './ma-templates/MPC-757.pdf',
    './ma-templates/MPC-801.pdf',
  ];

  const results = [];

  for (const formPath of forms) {
    if (!fs.existsSync(formPath)) {
      console.log('MISSING: ' + formPath);
      continue;
    }
    console.log('Inspecting: ' + formPath);
    try {
      const screenshot = formPath.includes('MPC-150') ? 'docs/MPC-150-rendered.png' : null;
      const result = await inspectForm(formPath, screenshot);
      results.push(result);
      console.log('  Found ' + result.fieldCount + ' fields');
      result.fields.forEach(f => {
        console.log('  [' + f.type + '] ' + f.name +
          (f.placeholder ? ' (' + f.placeholder + ')' : ''));
      });
    } catch (err) {
      console.log('  ERROR: ' + err.message);
      results.push({ formPath, error: err.message });
    }
  }

  // Save full results to file for reference
  fs.writeFileSync(
    'docs/xfa-field-inspection.json',
    JSON.stringify(results, null, 2)
  );
  console.log('\nFull results saved to docs/xfa-field-inspection.json');
}

main().catch(console.error);
