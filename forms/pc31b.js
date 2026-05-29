// PC-3.1B Universal Appointment Bond (With Corporate Surety)
// Per spec: fill petitioner info + checkbox only; leave surety fields blank.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR,
  addr, phone, email,
  setText, setCheckbox,
  fillHeader, identifyContacts,
} = require('./common');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-3.1B.pdf');

async function fillPC31B(matter, contacts, _assets, { petitionType = 'admin' } = {}) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent, representative } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );

  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  // Header (PC-3.1B: Combo Box 1/4, estate='2', alias='3', case='5')
  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 1', cityField: 'Combo Box 4', estateField: '2', aliasField: '3', caseField: '5' }
  );

  // Principal 1 = petitioner
  if (representative) {
    const a = addr(representative);
    setText(form, '7',  representative.full_name);
    setText(form, '8',  a.street ?? '');
    setText(form, '9',  a.city   ?? '');
    setText(form, '10', a.state  ?? '');
    setText(form, '11', a.postal_code ?? '');
    setText(form, '12', email(representative));
    setText(form, '13', phone(representative));
  }

  // Fiduciary type checkbox
  setCheckbox(form, petitionType === 'probate' ? 'Check Box1' : 'Check Box2', true);

  return { bytes: await pdfDoc.save(), warnings: [] };
}

module.exports = { fillPC31B };
