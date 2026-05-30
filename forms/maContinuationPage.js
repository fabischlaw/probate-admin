'use strict';
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const MAX_ROWS_PER_PAGE = 20;

/**
 * generateContinuationPages(options) → Buffer | null
 *
 * options: {
 *   formId, formTitle, decedentName, docketNumber, county,
 *   columns: [{ header, key, width }],
 *   entries: [{ [key]: value, … }],
 *   startingEntryNumber,   // default 1
 *   pageNumberOffset,      // starting page label (default 2 — continuation starts after page 1)
 * }
 *
 * Returns null when entries is empty.
 */
async function generateContinuationPages(options) {
  const {
    formId           = '',
    formTitle        = '',
    decedentName     = '',
    docketNumber     = '',
    county           = '',
    columns          = [],
    entries          = [],
    startingEntryNumber = 1,
    pageNumberOffset    = 2,
  } = options;

  if (!entries.length) return null;

  // ── Build column width CSS ────────────────────────────────────────────────
  const numColWidth = '32px';
  const colStyles = columns.map(c =>
    c.width ? `width:${c.width}` : ''
  );

  // ── Build table rows HTML ─────────────────────────────────────────────────
  const rowsHtml = entries.map((entry, i) => {
    const num   = startingEntryNumber + i;
    const cells = columns.map((c, ci) =>
      `<td style="${colStyles[ci]}">${escHtml(entry[c.key] ?? '')}</td>`
    ).join('');
    return `<tr><td class="num">${num}</td>${cells}</tr>`;
  }).join('\n');

  const headerCells = columns.map((c, ci) =>
    `<th style="${colStyles[ci]}">${escHtml(c.header)}</th>`
  ).join('');

  const docketDisplay = docketNumber || '___________';
  const countyDisplay = county ? `${county} Division` : '';

  // ── HTML document ─────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  @page { size: letter; margin: 1in; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    color: #000;
    margin: 0; padding: 0;
  }
  .court-header {
    text-align: center;
    padding-bottom: 5px;
    margin-bottom: 5px;
    border-bottom: 2px solid #000;
  }
  .court-header .top  { font-size: 11pt; font-weight: bold; }
  .court-header .sub  { font-size: 10.5pt; }
  .form-title {
    text-align: center;
    font-size: 11pt;
    font-weight: bold;
    margin: 6px 0 4px;
  }
  .caption {
    border: 1px solid #000;
    padding: 4px 8px;
    margin: 4px 0;
    font-size: 9.5pt;
    line-height: 1.5;
  }
  .caption .estate  { font-weight: bold; font-size: 10pt; }
  .attachment-note {
    font-style: italic;
    font-size: 8.5pt;
    text-align: center;
    margin: 4px 0 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 2px;
  }
  th {
    background: #ebebeb;
    border: 1px solid #000;
    padding: 3px 5px;
    font-size: 9pt;
    text-align: left;
    font-weight: bold;
  }
  td {
    border: 1px solid #000;
    padding: 3px 5px;
    font-size: 9pt;
    vertical-align: top;
    word-wrap: break-word;
  }
  th.num, td.num { text-align: center; width: ${numColWidth}; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <div class="court-header">
    <div class="top">Commonwealth of Massachusetts</div>
    <div class="sub">The Probate and Family Court</div>
  </div>

  <div class="form-title">MPC ${escHtml(formId)} &mdash; ${escHtml(formTitle)} (Continuation Sheet)</div>

  <div class="caption">
    <span class="estate">Estate of ${escHtml(decedentName)}</span>
    ${countyDisplay ? `&nbsp;&nbsp;&bull;&nbsp;&nbsp; ${escHtml(countyDisplay)}` : ''}
    &nbsp;&nbsp;&bull;&nbsp;&nbsp; Docket No: ${escHtml(docketDisplay)}
  </div>

  <p class="attachment-note">
    This continuation sheet is filed as part of Form MPC ${escHtml(formId)} and should be attached thereto.
  </p>

  <table>
    <thead>
      <tr>
        <th class="num">#</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;

  // ── Render with Puppeteer ─────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page    = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const footerTpl = `
    <div style="font-family:Arial,sans-serif;font-size:7.5pt;width:100%;
                text-align:center;color:#333;padding:0 72pt;">
      MPC&nbsp;${escHtml(formId)}&nbsp;Continuation&nbsp;&mdash;&nbsp;
      Page&nbsp;<span class="pageNumber"></span>&nbsp;of&nbsp;<span class="totalPages"></span>
    </div>`;

  const pdfBytes = await page.pdf({
    format:                'Letter',
    printBackground:       true,
    margin:                { top: '0.85in', right: '1in', bottom: '0.9in', left: '1in' },
    displayHeaderFooter:   true,
    headerTemplate:        '<div></div>',
    footerTemplate:        footerTpl,
  });

  await browser.close();
  return Buffer.from(pdfBytes);
}

/**
 * mergeWithContinuation(mainBytes, continuationBytes) → Promise<Buffer>
 *
 * Appends continuation page(s) after the main court form PDF.
 * Returns the mainBytes unchanged if continuationBytes is null/undefined.
 */
async function mergeWithContinuation(mainBytes, continuationBytes) {
  if (!continuationBytes) return Buffer.from(mainBytes);

  const merged = await PDFDocument.create();

  for (const src of [mainBytes, continuationBytes]) {
    const doc   = await PDFDocument.load(src);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  return Buffer.from(await merged.save());
}

// ── Helpers ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateContinuationPages, mergeWithContinuation };
