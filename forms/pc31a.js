// PC-3.1A Universal Appointment Bond (Corporate Surety Exempted)
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR,
  addr, phone, email,
  setText, setDropdown, setCheckbox,
  fillHeader, identifyContacts,
} = require('./common');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-3.1A.pdf');

async function fillPC31A(matter, contacts, _assets, { petitionType = 'admin' } = {}) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent, representative } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );

  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  // Header (PC-3.1A: Combo Box 2/3, estate='2', alias='3', case='5')
  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 2', cityField: 'Combo Box 3', estateField: '2', aliasField: '3', caseField: '5' }
  );

  // Principal 1 = petitioner
  if (representative) {
    const a = addr(representative);
    setText(form, '6',  representative.full_name);
    setText(form, '7',  a.street ?? '');
    setText(form, '8',  a.city   ?? '');
    setText(form, '9',  a.state  ?? '');
    setText(form, '10', a.postal_code ?? '');
    setText(form, '11', email(representative));
    setText(form, '12', phone(representative));
  }

  // Fiduciary type checkbox
  setCheckbox(form, petitionType === 'probate' ? 'Check Box1' : 'Check Box2', true);

  return { bytes: await pdfDoc.save(), warnings: [] };
}

module.exports = { fillPC31A };
