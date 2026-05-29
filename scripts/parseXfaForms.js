'use strict';

/**
 * parseXfaForms.js
 *
 * For each of the 17 MA probate forms:
 *   1. Extracts the XFA template XML from the PDF (FlateDecode stream containing <template)
 *   2. Parses the XML to build a structured JSON description of the form
 *   3. Saves JSON to docs/xfa-parsed/MPC-XXX.json
 *   4. Rasterizes page 1 at 200 DPI via pdfjs-dist + canvas, saves to /tmp/form-pages/MPC-XXX-p1.jpg
 *
 * For forms without XFA (MPC-470, MPC-750), still rasterizes page 1 and records
 * a JSON with a note explaining the form type.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pdfjsLib = require(path.join(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.js'));
const { createCanvas } = require(path.join(__dirname, '../node_modules/canvas'));

const TEMPLATES_DIR = path.join(__dirname, '../ma-templates');
const OUTPUT_JSON_DIR = path.join(__dirname, '../docs/xfa-parsed');
const OUTPUT_IMG_DIR = '/tmp/form-pages';
const STANDARD_FONTS_URL = path.join(__dirname, '../node_modules/pdfjs-dist/standard_fonts/');

const FORMS = [
  'MPC-150', 'MPC-160', 'MPC-161', 'MPC-162', 'MPC-163',
  'MPC-170', 'MPC-455', 'MPC-470', 'MPC-475', 'MPC-480',
  'MPC-485', 'MPC-550', 'MPC-551', 'MPC-750', 'MPC-755',
  'MPC-757', 'MPC-801',
];

// ─── XFA extraction ────────────────────────────────────────────────────────────

/**
 * Extract the XFA template XML string from a PDF buffer.
 * Returns null if no XFA template stream is found.
 */
function extractXfaTemplate(pdfBuf) {
  let pos = 0;
  while (pos < pdfBuf.length - 10) {
    // Find next stream marker (handles both \r\n and \n variants)
    const idx1 = pdfBuf.indexOf(Buffer.from('stream\r\n'), pos);
    const idx2 = pdfBuf.indexOf(Buffer.from('stream\n'), pos);
    const streamStart =
      idx1 === -1 ? idx2 :
      idx2 === -1 ? idx1 :
      Math.min(idx1, idx2);
    if (streamStart === -1) break;

    const headerStart = Math.max(0, streamStart - 500);
    const header = pdfBuf.slice(headerStart, streamStart).toString('latin1');

    if (header.includes('FlateDecode')) {
      const dataStart = streamStart + (pdfBuf[streamStart + 6] === 13 ? 8 : 7); // \r\n = 8, \n = 7
      const endIdx = pdfBuf.indexOf(Buffer.from('endstream'), dataStart);
      if (endIdx > dataStart) {
        const compressed = pdfBuf.slice(dataStart, endIdx);
        try {
          const decompressed = zlib.inflateSync(compressed);
          const prefix = decompressed.slice(0, 50).toString('utf8').trim();
          if (prefix.startsWith('<template') || prefix.includes('<template ')) {
            return decompressed.toString('utf8');
          }
        } catch (_) {
          // not a valid zlib stream — skip
        }
      }
    }
    pos = streamStart + 7;
  }
  return null;
}

// ─── XML attribute helpers ─────────────────────────────────────────────────────

/** Extract a named attribute value from an opening-tag attribute string. */
function getAttr(attrStr, name) {
  // Handles name="value" and name='value'
  const re = new RegExp(name + '=["\']([^"\']*)["\']');
  const m = attrStr.match(re);
  return m ? m[1] : null;
}

/** Normalise a dimension string: ensure "mm" suffix, handle "in" → mm. */
function normDim(val) {
  if (!val) return null;
  val = val.trim();
  if (val.endsWith('mm')) return val;
  if (val.endsWith('in')) {
    const inches = parseFloat(val);
    return (inches * 25.4).toFixed(4) + 'mm';
  }
  if (val.endsWith('pt')) {
    const pts = parseFloat(val);
    return (pts * 0.352778).toFixed(4) + 'mm';
  }
  // already bare number or unknown – return as-is
  return val;
}

// ─── XML parser (manual, no external deps) ─────────────────────────────────────

/**
 * Light recursive-descent parser for XFA template XML.
 *
 * Adobe LiveCycle Designer emits a non-standard XML variant where:
 *   - Opening tags may span two lines:  <subform name="foo"\n>
 *   - Closing tags also span two lines: </subform\n>
 *   - Self-closing tags end with:       \n/>
 *   - Processing instructions appear inside element content
 *
 * We normalise this by pre-processing the XML into canonical form, then walk
 * it with a simple tokeniser.  We avoid a full DOM library so there are zero
 * extra dependencies.
 */
function parseXfaXml(xml, formId) {
  const elements = [];
  const pages = [];

  // ── Pre-normalise the XFA abbreviated-XML syntax ────────────────────────
  // Replace </tagname\n> with </tagname>  and  <tagname attrs\n> with <tagname attrs>
  // The pattern: any < that is not followed by more < before the next >
  // Simpler: replace  \n>  with  >  and  \n/>  with  />  globally.
  // This is safe because text content in XFA draw/field uses \n which we don't
  // want to strip — but those \n are inside >…< not inside tag markers.
  // We only want to strip \n that are immediately before a lone >.
  // Pattern: \n> (newline then >) where the newline is inside a tag (between < and >)
  // We'll do it with a state machine scan.
  let normalised = '';
  let inTag = false;
  for (let i = 0; i < xml.length; i++) {
    const c = xml[i];
    if (c === '<' && xml[i + 1] !== '!') { // don't mis-count comment start <!--
      inTag = true;
      normalised += c;
    } else if (c === '>') {
      inTag = false;
      normalised += c;
    } else if (inTag && c === '\n') {
      // Skip the newline — it's whitespace inside an opening/closing tag token
      // (don't add it)
    } else {
      normalised += c;
    }
  }
  xml = normalised;

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Parse mm value to float, 0 if absent/null */
  function toMm(str) {
    if (!str) return 0;
    str = str.trim();
    if (str.endsWith('mm')) return parseFloat(str);
    if (str.endsWith('in')) return parseFloat(str) * 25.4;
    if (str.endsWith('pt')) return parseFloat(str) * 0.352778;
    return parseFloat(str) || 0;
  }

  /** Format float back to compact mm string */
  function fmm(val) {
    // keep up to 4 decimal places, strip trailing zeros
    return parseFloat(val.toFixed(4)) + 'mm';
  }

  /**
   * Extract the text content of the first <text>…</text> within a chunk.
   * Strips any nested tags (e.g. <font> inside rich-text values).
   */
  function extractText(s) {
    const m = s.match(/<text[^>]*>([\s\S]*?)<\/text>/);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
  }

  /**
   * Find the position just after the matching close tag for a given element.
   *
   * afterOpenGt: position immediately after the opening '>' of the element.
   * tagName: the element name (e.g. "subform").
   *
   * Returns position after </tagname>, or -1 if not found.
   *
   * XFA may have many nested elements of the same name, so we count depth.
   * After normalisation, tags are canonical: <tag ...> or </tag> or <tag .../>
   */
  function findClose(afterOpenGt, tagName) {
    // openTag prefix — must be followed by whitespace, /, or > to avoid
    // false matches e.g. <subformSet> when searching for <subform>
    const openPre = '<' + tagName;
    const closeTag = '</' + tagName + '>';
    let depth = 1;
    let p = afterOpenGt;

    while (p < xml.length && depth > 0) {
      // Find whichever comes first: another open of same tag, or a close
      let nextOpen = -1;
      let searchO = p;
      while (searchO < xml.length) {
        const idx = xml.indexOf(openPre, searchO);
        if (idx === -1) break;
        // Confirm next char is whitespace, >, or /
        const ch = xml[idx + openPre.length];
        if (ch === ' ' || ch === '\t' || ch === '>' || ch === '/') {
          nextOpen = idx;
          break;
        }
        searchO = idx + 1;
      }

      const nextClose = xml.indexOf(closeTag, p);

      if (nextClose === -1) return -1; // malformed XML

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // It's another opening of the same element — check if self-closing
        const openGt = xml.indexOf('>', nextOpen);
        if (openGt === -1) return -1;
        const tagToken = xml.slice(nextOpen, openGt + 1);
        if (!tagToken.endsWith('/>')) {
          depth++;
        }
        p = openGt + 1;
      } else {
        depth--;
        p = nextClose + closeTag.length;
        if (depth === 0) return p;
      }
    }
    return -1;
  }

  // ── Main walker ──────────────────────────────────────────────────────────

  /**
   * Walk xml[start..end], emitting elements into the `elements` and `pages` arrays.
   *
   * parentPath: dot-separated path of ancestor element names
   * parentAbsX, parentAbsY: accumulated mm offsets from ancestor subforms
   * depth: recursion guard
   */
  function walk(start, end, parentPath, parentAbsX, parentAbsY, depth) {
    if (depth > 60) return;
    let p = start;

    while (p < end) {
      const lt = xml.indexOf('<', p);
      if (lt === -1 || lt >= end) break;

      const c1 = xml[lt + 1];

      // Processing instruction: <?…?>
      if (c1 === '?') {
        const closePI = xml.indexOf('?>', lt + 2);
        p = closePI === -1 ? end : closePI + 2;
        continue;
      }

      // Comment: <!--…-->
      if (xml.startsWith('<!--', lt)) {
        const closeComment = xml.indexOf('-->', lt + 4);
        p = closeComment === -1 ? end : closeComment + 3;
        continue;
      }

      // Close tag: </…>  — skip; we track closes via findClose
      if (c1 === '/') {
        const gt = xml.indexOf('>', lt);
        p = gt === -1 ? end : gt + 1;
        continue;
      }

      // Opening tag: find its closing >
      let gt = lt + 1;
      let inStr = false, strChar = '';
      while (gt < xml.length) {
        const ch = xml[gt];
        if (inStr) { if (ch === strChar) inStr = false; }
        else if (ch === '"' || ch === "'") { inStr = true; strChar = ch; }
        else if (ch === '>') break;
        gt++;
      }
      if (gt >= xml.length || gt >= end + 200) { // +200 for tags that straddle range boundary
        break;
      }

      const tagToken = xml.slice(lt + 1, gt); // without < and >
      const selfClosing = tagToken.endsWith('/');
      const tagText = selfClosing ? tagToken.slice(0, -1).trim() : tagToken;

      // Extract tag name (up to first whitespace)
      const spaceIdx = tagText.search(/\s/);
      const tagName = spaceIdx === -1 ? tagText.trim() : tagText.slice(0, spaceIdx);
      const attrStr = spaceIdx === -1 ? '' : tagText.slice(spaceIdx + 1);

      // Skip namespace-prefixed tags used as wrappers
      if (!tagName || tagName.includes(':')) {
        p = gt + 1;
        continue;
      }

      const afterGt = gt + 1;

      // ── pageArea ────────────────────────────────────────────────────────
      if (tagName === 'pageArea') {
        const name = getAttr(attrStr, 'name') || ('Page' + (pages.length + 1));
        let innerEnd;
        if (selfClosing) {
          innerEnd = afterGt;
        } else {
          const closePos = findClose(afterGt, 'pageArea');
          innerEnd = closePos === -1 ? end : closePos;
        }

        // Extract <medium short="215.9mm" long="279.4mm"> from this pageArea
        let wMm = '215.9mm', hMm = '279.4mm';
        const searchStr = xml.slice(afterGt, innerEnd);
        const medM = searchStr.match(/<medium[^>]*>/);
        if (medM) {
          const s = getAttr(medM[0], 'short');
          const l = getAttr(medM[0], 'long');
          if (s) wMm = normDim(s);
          if (l) hMm = normDim(l);
        }

        pages.push({ pageNum: pages.length + 1, pageName: name, width: wMm, height: hMm });

        if (!selfClosing) {
          walk(afterGt, innerEnd, parentPath, parentAbsX, parentAbsY, depth + 1);
          p = innerEnd;
        } else {
          p = afterGt;
        }
        continue;
      }

      // ── subform ─────────────────────────────────────────────────────────
      if (tagName === 'subform') {
        const name = getAttr(attrStr, 'name') || 'subform';
        const localX = toMm(normDim(getAttr(attrStr, 'x')));
        const localY = toMm(normDim(getAttr(attrStr, 'y')));
        const wVal = normDim(getAttr(attrStr, 'w'));
        const hVal = normDim(getAttr(attrStr, 'h'));
        const absX = parentAbsX + localX;
        const absY = parentAbsY + localY;
        const myPath = parentPath ? parentPath + '.' + name : name;

        const entry = {
          type: 'subform',
          name,
          x: fmm(absX),
          y: fmm(absY),
          parentPath,
        };
        if (wVal) entry.w = wVal;
        if (hVal) entry.h = hVal;
        elements.push(entry);

        if (!selfClosing) {
          const closePos = findClose(afterGt, 'subform');
          const innerEnd = closePos === -1 ? end : closePos;
          walk(afterGt, innerEnd, myPath, absX, absY, depth + 1);
          p = innerEnd;
        } else {
          p = afterGt;
        }
        continue;
      }

      // ── field ────────────────────────────────────────────────────────────
      if (tagName === 'field') {
        const name = getAttr(attrStr, 'name') || 'field';
        const localX = toMm(normDim(getAttr(attrStr, 'x')));
        const localY = toMm(normDim(getAttr(attrStr, 'y')));
        const wVal = normDim(getAttr(attrStr, 'w'));
        const hVal = normDim(getAttr(attrStr, 'h'));
        const absX = parentAbsX + localX;
        const absY = parentAbsY + localY;

        let fieldType = 'text';
        let captionText = null;

        if (!selfClosing) {
          const closePos = findClose(afterGt, 'field');
          const innerEnd = closePos === -1 ? end : closePos;
          const inner = xml.slice(afterGt, innerEnd);

          if (inner.includes('<checkButton')) fieldType = 'checkbox';
          else if (inner.includes('<choiceList')) fieldType = 'dropdown';
          else if (inner.includes('<dateTimeEdit')) fieldType = 'date';
          else if (inner.includes('<numericEdit')) fieldType = 'number';
          else if (inner.includes('<signField')) fieldType = 'signature';
          else if (inner.includes('<imageEdit')) fieldType = 'image';
          else fieldType = 'text';

          // Extract caption: <caption …><…><value><text>LABEL</text>
          const capM = inner.match(/<caption[^>]*\/?>[\s\S]*?<\/caption>/);
          if (capM) captionText = extractText(capM[0]);

          const entry = {
            type: 'field', name, fieldType,
            caption: captionText,
            x: fmm(absX), y: fmm(absY),
            parentPath,
          };
          if (wVal) entry.w = wVal;
          if (hVal) entry.h = hVal;
          elements.push(entry);
          p = innerEnd;
        } else {
          elements.push({
            type: 'field', name, fieldType,
            caption: null,
            x: fmm(absX), y: fmm(absY),
            parentPath,
          });
          p = afterGt;
        }
        continue;
      }

      // ── draw ─────────────────────────────────────────────────────────────
      if (tagName === 'draw') {
        const name = getAttr(attrStr, 'name') || '';
        const localX = toMm(normDim(getAttr(attrStr, 'x')));
        const localY = toMm(normDim(getAttr(attrStr, 'y')));
        const wVal = normDim(getAttr(attrStr, 'w'));
        const hVal = normDim(getAttr(attrStr, 'h'));
        const absX = parentAbsX + localX;
        const absY = parentAbsY + localY;

        if (!selfClosing) {
          const closePos = findClose(afterGt, 'draw');
          const innerEnd = closePos === -1 ? end : closePos;
          const inner = xml.slice(afterGt, innerEnd);

          let drawText = null;
          // <value><text>...</text></value>
          const valM = inner.match(/<value[^>]*\/?>[\s\S]*?<\/value>/);
          if (valM) drawText = extractText(valM[0]);
          // Fallback: <caption>…<value><text>…
          if (!drawText) {
            const capM = inner.match(/<caption[^>]*\/?>[\s\S]*?<\/caption>/);
            if (capM) {
              const capValM = capM[0].match(/<value[^>]*\/?>[\s\S]*?<\/value>/);
              if (capValM) drawText = extractText(capValM[0]);
            }
          }

          if (drawText) {
            const entry = {
              type: 'draw',
              text: drawText,
              x: fmm(absX), y: fmm(absY),
              parentPath,
            };
            if (name) entry.name = name;
            if (wVal) entry.w = wVal;
            if (hVal) entry.h = hVal;
            elements.push(entry);
          }
          p = innerEnd;
        } else {
          p = afterGt;
        }
        continue;
      }

      // ── all other tags: recurse if non-self-closing ───────────────────────
      // We DO recurse into everything (pageSet, ui, event, etc.) because
      // subforms/fields/draws can appear anywhere in the tree.  We just don't
      // accumulate x/y offsets for non-subform containers.
      if (!selfClosing) {
        // Skip tags that we know can't contain layout elements to save time
        const skipTags = new Set([
          'ui', 'textEdit', 'checkButton', 'choiceList', 'dateTimeEdit',
          'numericEdit', 'signField', 'imageEdit', 'barcode', 'defaultUi',
          'font', 'margin', 'para', 'border', 'edge', 'corner', 'fill',
          'color', 'linear', 'radial', 'pattern', 'stipple', 'exData',
          'validate', 'message', 'bind', 'calculate', 'event', 'script',
          'format', 'picture', 'items', 'traversal', 'traverse', 'occur',
          'proto', 'variables', 'assist', 'toolTip', 'speak', 'extras',
          'medium', 'contentArea', 'desc', 'bookend', 'setProperty',
          'connect', 'execute', 'signData', 'certificate',
          'encryptionMethod', 'reason', 'lockDocument', 'breakBefore',
          'breakAfter', 'keep', 'overflow',
          // pageSet is NOT skipped — it contains pageArea elements
        ]);

        if (skipTags.has(tagName)) {
          // find and skip the whole element
          const closePos = findClose(afterGt, tagName);
          p = closePos === -1 ? afterGt : closePos;
        } else {
          const closePos = findClose(afterGt, tagName);
          if (closePos !== -1) {
            walk(afterGt, closePos, parentPath, parentAbsX, parentAbsY, depth + 1);
            p = closePos;
          } else {
            p = afterGt;
          }
        }
      } else {
        p = afterGt;
      }
    }
  }

  // Locate <template …> opening tag
  const templateStart = xml.indexOf('<template');
  if (templateStart === -1) return null;
  const templateGt = xml.indexOf('>', templateStart);
  if (templateGt === -1) return null;
  const templateClose = xml.lastIndexOf('</template>');
  const templateEnd = templateClose === -1 ? xml.length : templateClose;

  // Start with empty parentPath — the <subform name="form1"> at root will
  // register itself with parentPath="" and path "form1", and its children
  // will get parentPath "form1.form1" unless we handle this.
  // Actually start inside the template body (skip the template element itself).
  walk(templateGt + 1, templateEnd, '', 0, 0, 0);

  return { pages, elements };
}

// ─── PDF rasterisation ─────────────────────────────────────────────────────────

async function rasterizePage1(pdfPath, outJpgPath) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = false;

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS_URL,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    throw new Error('pdfjs load failed: ' + err.message);
  }

  const page = await pdf.getPage(1);
  const scale = 200 / 72; // 200 DPI
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');

  // Fill white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const jpgBuf = canvas.toBuffer('image/jpeg', { quality: 0.85 });
  fs.writeFileSync(outJpgPath, jpgBuf);

  return { numPages: pdf.numPages, width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_JSON_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_IMG_DIR, { recursive: true });

  const report = [];

  for (const formId of FORMS) {
    const pdfPath = path.join(TEMPLATES_DIR, formId + '.pdf');
    const jsonPath = path.join(OUTPUT_JSON_DIR, formId + '.json');
    const jpgPath = path.join(OUTPUT_IMG_DIR, formId + '-p1.jpg');

    console.log('\n── ' + formId + ' ──────────────────────────────────');

    const entry = { formId, xfaParsed: false, rasterized: false, issues: [] };

    if (!fs.existsSync(pdfPath)) {
      const msg = 'PDF not found: ' + pdfPath;
      console.warn('  SKIP: ' + msg);
      entry.issues.push(msg);
      report.push(entry);
      continue;
    }

    const pdfBuf = fs.readFileSync(pdfPath);

    // ── XFA extraction & parsing ──────────────────────────────────────────
    let jsonDoc = null;
    const templateXml = extractXfaTemplate(pdfBuf);

    if (!templateXml) {
      const msg = 'No XFA template stream found (form may be AcroForm or static PDF)';
      console.warn('  XFA: ' + msg);
      entry.issues.push(msg);
      entry.xfaType = 'none';
    } else {
      console.log('  XFA: template XML length=' + templateXml.length);
      try {
        const parsed = parseXfaXml(templateXml, formId);
        if (!parsed) {
          throw new Error('parseXfaXml returned null');
        }

        const { pages, elements } = parsed;
        console.log('  Parsed: ' + pages.length + ' pages, ' + elements.length + ' elements');

        // Count by type
        const counts = { subform: 0, field: 0, draw: 0 };
        for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
        console.log('  Breakdown: subforms=' + counts.subform + ' fields=' + counts.field + ' draws=' + counts.draw);

        jsonDoc = {
          formId,
          pageCount: pages.length,
          pages,
          elements,
        };

        fs.writeFileSync(jsonPath, JSON.stringify(jsonDoc, null, 2));
        entry.xfaParsed = true;
        entry.pageCount = pages.length;
        entry.elementCount = elements.length;
        entry.counts = counts;
        console.log('  JSON saved: ' + jsonPath);
      } catch (err) {
        const msg = 'Parse error: ' + err.message;
        console.error('  ERROR: ' + msg);
        entry.issues.push(msg);
      }
    }

    // For forms without XFA, still write a minimal JSON with a note
    if (!jsonDoc) {
      // Try to get page count from pdfjs
      let numPages = 1;
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = false;
        const data = new Uint8Array(pdfBuf);
        const pdf = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONTS_URL, verbosity: 0 }).promise;
        numPages = pdf.numPages;
      } catch (_) {}

      jsonDoc = {
        formId,
        pageCount: numPages,
        note: entry.issues.join('; '),
        pages: [],
        elements: [],
      };
      fs.writeFileSync(jsonPath, JSON.stringify(jsonDoc, null, 2));
      entry.pageCount = numPages;
    }

    // ── Rasterise page 1 ─────────────────────────────────────────────────
    try {
      const imgInfo = await rasterizePage1(pdfPath, jpgPath);
      entry.rasterized = true;
      entry.imgSize = imgInfo.width + 'x' + imgInfo.height;
      if (!entry.pageCount) entry.pageCount = imgInfo.numPages;
      console.log('  JPG saved: ' + jpgPath + ' (' + entry.imgSize + ')');
    } catch (err) {
      const msg = 'Rasterize error: ' + err.message;
      console.error('  ERROR: ' + msg);
      entry.issues.push(msg);
    }

    report.push(entry);
  }

  // ── Final report ─────────────────────────────────────────────────────────
  console.log('\n\n════════════════════════════════════════════');
  console.log('SUMMARY REPORT');
  console.log('════════════════════════════════════════════');

  for (const e of report) {
    const status = e.xfaParsed ? 'OK' : (e.issues.length ? 'ISSUE' : 'SKIP');
    let line = '[' + status + '] ' + e.formId;
    line += '  pages=' + (e.pageCount || '?');
    if (e.xfaParsed) line += '  elements=' + e.elementCount + ' (' + JSON.stringify(e.counts) + ')';
    if (e.rasterized) line += '  jpg=' + e.imgSize;
    if (e.issues.length) line += '  issues: ' + e.issues.join('; ');
    console.log(line);
  }

  // ── Sample elements from MPC-150 ──────────────────────────────────────────
  const mpc150Path = path.join(OUTPUT_JSON_DIR, 'MPC-150.json');
  if (fs.existsSync(mpc150Path)) {
    const mpc150 = JSON.parse(fs.readFileSync(mpc150Path, 'utf8'));
    console.log('\n────────────────────────────────────────────');
    console.log('SAMPLE ELEMENTS from MPC-150 (first 10 with text content):');
    console.log('────────────────────────────────────────────');
    let shown = 0;
    for (const el of mpc150.elements) {
      if (shown >= 10) break;
      if (el.type === 'field' || (el.type === 'draw' && el.text)) {
        console.log(JSON.stringify(el, null, 2));
        shown++;
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
