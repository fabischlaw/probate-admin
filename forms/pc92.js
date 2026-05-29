// PC-9.2 Attorney of Record
// Fill first attorney block with firm info; leave blocks 2 and 3 blank.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR, FIRM,
  addr,
  setText,
  fillHeader, identifyContacts,
} = require('./common');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-9.2.pdf');

async function fillPC92(matter, contacts, _assets) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  // Header (PC-9.2: Combo Box 4/5, estate='3', alias='4', case='6')
  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 4', cityField: 'Combo Box 5', estateField: '3', aliasField: '4', caseField: '6' }
  );

  // Attorney block 1 = firm info
  setText(form, '7',  FIRM.name);
  setText(form, '8',  '');           // Bar number — left for attorney to fill
  setText(form, '9',  FIRM.firm);
  setText(form, '10', FIRM.street);
  setText(form, '11', FIRM.city);
  setText(form, '12', FIRM.state);
  setText(form, '13', FIRM.zip);
  setText(form, '14', FIRM.email);
  setText(form, '15', FIRM.phone);
  // Blocks 2 and 3 (fields 17-28, 29-35) left blank

  return { bytes: await pdfDoc.save(), warnings: [] };
}

module.exports = { fillPC92 };
