'use strict';
const { PDFDocument } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');
const { addr, phone, email, formatDate, identifyContacts, FIRM, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const TEMPLATE = path.join(__dirname, '../ma-templates/MPC-470.pdf');

// AcroForm-based filler (pdf-lib) — MPC-470 is a standard Servicemembers Civil Relief Act affidavit
async function fillMPC470(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-470: No decedent contact found');

  // Build list of heirs/interested persons to check for military service
  const HEIR_TYPES = new Set(['1MARR','1WIDW','3LIFP',
                               '2SON','2DATR','3GSON','3GDTR',
                               '3FATH','3MOTH','3BROT','3SIST','3SIBL',
                               '3AUNT','3UCLE','3NIEC','3NEPW','3COUS','3OTHE','4FRIE']);
  const heirs = contacts.filter(c => HEIR_TYPES.has(c.relationship?.type));

  const decAddr = addr(dec);
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');
  const today    = new Date();
  const sigDate  = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  function setText(name, val) {
    try { form.getTextField(name).setText(val || ''); } catch (_) {}
  }
  function setCheck(name, val) {
    try { if (val) form.getCheckBox(name).check(); else form.getCheckBox(name).uncheck(); } catch (_) {}
  }

  setText('DOCKET NUMBER', matter.docket_no || '');
  setText('Plaintiff(s)',  dec ? `Estate of ${dec.full_name || [dec.first_name, dec.last_name].filter(Boolean).join(' ')}` : '');
  setText('Court Division or County', division);

  // Heirs listed in Section A (not in military service)
  const heirNames = heirs.map(h => h.full_name || [h.first_name, h.last_name].filter(Boolean).join(' '));
  setText('A 1', heirNames[0] || '');
  setText('A 2', heirNames[1] || '');
  setText('A 3', heirNames[2] || '');

  if (heirNames.length > 3) {
    warnings.push(`MPC-470: ${heirNames.length} heirs found; only 3 fit in Section A. Add remainder manually.`);
  }

  // Checkbox 1A = parties not in military service (standard probate scenario)
  setCheck('1A', true);

  // Affiant / attorney block
  const affiName  = rep ? `${rep.full_name || [rep.first_name, rep.last_name].filter(Boolean).join(' ')}` : '';
  const affiAddr  = addr(rep);
  const attyBlock = [
    FIRM.full || FIRM.name,
    FIRM.street,
    `${FIRM.city}, ${FIRM.state} ${FIRM.zip}`,
    FIRM.phone,
    FIRM.email,
  ].filter(Boolean).join('\n');

  setText('Insert Your Name',               affiName);
  setText('Name, Address, Phone, E-Mail',   attyBlock);
  setText('BBO Number',                     FIRM.bbo || '');
  setText('Date_af_date',                   sigDate);
  setText('Date3_af_date',                  sigDate);

  form.updateFieldAppearances();
  return { bytes: await pdfDoc.save(), warnings };
}

module.exports = { fillMPC470 };
