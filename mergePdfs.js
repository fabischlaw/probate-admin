const { PDFDocument } = require('pdf-lib');

/**
 * Merges an array of filled PDF byte buffers into a single PDF.
 * Each source is flattened before merge to prevent field-name conflicts.
 */
async function mergePdfs(buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    src.getForm().flatten();
    const indices = src.getPageIndices();
    const pages   = await merged.copyPages(src, indices);
    pages.forEach(p => merged.addPage(p));
  }
  return merged.save();
}

module.exports = { mergePdfs };
