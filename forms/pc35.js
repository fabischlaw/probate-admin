// PC-3.5 Appointment of Agent (Resident Agent)
// Fiduciary section = petitioner; Resident Agent section = firm info.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR, FIRM,
  addr, phone, email,
  setText, setCheckbox,
  fillHeader, identifyContacts,
} = require('./common');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-3.5.pdf');

async function fillPC35(matter, contacts, _assets, { petitionType = 'admin' } = {}) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent, representative } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );

  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  // Header (PC-3.5: Combo Box 4/5, estate='3', alias='4', case='6')
  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 4', cityField: 'Combo Box 5', estateField: '3', aliasField: '4', caseField: '6' }
  );

  // Fiduciary section = petitioner
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

  // Fiduciary type: Check Box1=Executor, Check Box2=Administrator
  setCheckbox(form, petitionType === 'probate' ? 'Check Box1' : 'Check Box2', true);

  // Resident Agent section = firm info
  setText(form, '15', FIRM.full);
  setText(form, '16', FIRM.street);
  setText(form, '17', FIRM.city);
  setText(form, '18', FIRM.state);
  setText(form, '19', FIRM.zip);
  setText(form, '20', FIRM.email);
  setText(form, '21', FIRM.phone);

  return { bytes: await pdfDoc.save(), warnings: [] };
}

module.exports = { fillPC35 };
