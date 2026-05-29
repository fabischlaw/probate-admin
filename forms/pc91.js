// PC-9.1 Waiver (Section A)
// Page 1 holds 4 signatory slots. For more than 4, page 1 is duplicated per group of 4.
// Page 2 (Section B - newspaper advertising) is omitted from output.
const { PDFDocument, StandardFonts, PDFName, PDFNumber } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR,
  addr,
  setText, setCheckbox,
  fillHeader, identifyContacts,
} = require('./common');
const { buildHeirList } = require('../heirLogic');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-9.1.pdf');

const SLOT_FIELDS = [
  { name: '8',  notary: '9',  date: '10', commission: '11' },
  { name: '12', notary: '13', date: '14', commission: '15' },
  { name: '16', notary: '17', date: '18', commission: '19' },
  { name: '20', notary: '21', date: '22', commission: '23' },
];

async function fillOnePage(matter, contacts, decedentCity, petitionType, group) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();
  const { decedent } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );

  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 4', cityField: 'Combo Box 5', estateField: '3', aliasField: '4', caseField: '6' }
  );

  setText(form, '7', petitionType === 'probate' ? 'Petition for Probate of Will' : 'Administration Petition');
  setCheckbox(form, petitionType === 'probate' ? 'Check Box1' : 'Check Box2', true);

  group.forEach((person, i) => {
    if (i >= SLOT_FIELDS.length) return;
    const name = person.full_name ?? [person.first_name, person.last_name].filter(Boolean).join(' ');
    setText(form, SLOT_FIELDS[i].name, name);
    // Notary, date, commission left blank — signatories complete at signing
  });

  // All PC-9.1 text fields have the Comb flag (bit 24, /Ff 8388608) set with no MaxLen.
  // pdf-lib's flatten() without updateFieldAppearances renders text at (0,0) of the
  // appearance stream — visually off-page. Clear Comb, regenerate appearances first.
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (const field of form.getFields()) {
    const acro = field.acroField;
    const ff = acro.dict.get(PDFName.of('Ff'));
    if (ff) {
      const cleared = Number(ff.toString()) & ~8388608;
      acro.dict.set(PDFName.of('Ff'), PDFNumber.of(cleared));
    }
  }
  form.updateFieldAppearances(font);

  return pdfDoc;
}

async function fillPC91(matter, contacts, _assets, { petitionType = 'admin', selectedBeneficiaryIds = null } = {}) {
  const { decedent } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  // Use the same ordered list as the petitions — single source of truth
  const { list, warnings } = buildHeirList(contacts, petitionType, selectedBeneficiaryIds);

  // Split into groups of 4; always produce at least one page
  const groups = [];
  for (let i = 0; i < Math.max(list.length, 1); i += 4) {
    groups.push(list.slice(i, i + 4));
  }

  const merged = await PDFDocument.create();
  for (const group of groups) {
    const filled = await fillOnePage(matter, contacts, decedentCity, petitionType, group);
    // Flatten before copying: copyPages transfers page content but not the AcroForm
    // dictionary, so field values would be lost. Flattening burns the values into the
    // page content stream first.
    filled.getForm().flatten();
    const [pg] = await merged.copyPages(filled, [0]);
    merged.addPage(pg);
  }

  return { bytes: await merged.save(), warnings };
}

module.exports = { fillPC91 };
