// PC-1.1 Administration Petition
const { PDFDocument } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR, RESIDENT_AGENT,
  formatDate, sumAssets, isRI,
  addr, phone, email, fullAddr,
  setText, drawX,
  fillHeader, identifyContacts,
} = require('./common');
const { buildHeirList } = require('../heirLogic');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-1.1-administration-petition.pdf');

// Page 1A: 10 rows, 4 fields each [name, relationship, addr1, addr2]
const PAGE1A_GROUPS = [
  ['62','63','64','65'], ['66','67','68','69'], ['70','71','72','73'],
  ['74','75','76','77'], ['78','79','80','81'], ['82','83','84','85'],
  ['86','87','88','89'], ['90','91','92','93'], ['94','95','96','97'],
  ['98','99','100','101'],
];

async function fillPC11(matter, contacts, assets, { petitionType = 'admin', selectedBeneficiaryIds = null } = {}) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent, representative } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const { list, hasSpouse, warnings } = buildHeirList(contacts, petitionType, selectedBeneficiaryIds);

  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 4', cityField: 'Combo Box 5', estateField: '3', aliasField: '4', caseField: '6' }
  );

  setText(form, '8',  decedent?.full_name);
  setText(form, '10', decedentCity);
  setText(form, '11', formatDate(decedent?.date_of_death ?? matter.contact_main?.date_of_death));
  setText(form, '9',  sumAssets(assets));

  if (representative) {
    const a = addr(representative);
    const relEntry = contacts.find(c => c.id === representative.id);
    const relShort = relEntry?.relationship?.short ?? '';
    let petRel = relShort;
    if (!relShort || relShort.toLowerCase() === 'client') {
      warnings.push('Warning: Petitioner relationship to deceased is missing — please fill in manually before filing.');
      petRel = '';
    }

    setText(form, '12', representative.full_name);
    setText(form, '13', petRel);
    setText(form, '14', a.street ?? '');
    setText(form, '15', a.city   ?? '');
    setText(form, '16', a.state  ?? '');
    setText(form, '17', a.postal_code ?? '');
    setText(form, '18', phone(representative));

    // Nominee defaults to petitioner
    setText(form, '19', representative.full_name);
    setText(form, '20', petRel);
    setText(form, '21', a.street ?? '');
    setText(form, '22', a.city   ?? '');
    setText(form, '23', a.state  ?? '');
    setText(form, '24', a.postal_code ?? '');

    // Decree: Fiduciary = petitioner
    setText(form, '102', representative.full_name);
    setText(form, '103', a.street ?? '');
    setText(form, '104', a.city   ?? '');
    setText(form, '105', a.state  ?? '');
    setText(form, '106', a.postal_code ?? '');
    setText(form, '107', email(representative));
    setText(form, '108', phone(representative));

    drawX(pdfDoc.getPages()[2], 148, 462);

    if (!isRI(a.state)) {
      setText(form, '1031', RESIDENT_AGENT.name);
      setText(form, '1032', RESIDENT_AGENT.street);
      setText(form, '1033', RESIDENT_AGENT.city);
      setText(form, '1034', RESIDENT_AGENT.state);
      setText(form, '1035', RESIDENT_AGENT.zip);
      setText(form, '1036', RESIDENT_AGENT.email);
      setText(form, '1037', RESIDENT_AGENT.phone);
    }
  }

  // --- Heir layout ---
  // Spouse row (31-32): filled if list[0] is a spouse; no relationship field
  // Two heir rows (33-38): next 2 from list
  // Page 1A (62-101): overflow beyond those 2, up to 10

  if (hasSpouse) {
    const s = list[0];
    setText(form, '31', s.full_name);
    setText(form, '32', fullAddr(addr(s)));
  }

  const nonSpouseStart = hasSpouse ? 1 : 0;
  const h1 = list[nonSpouseStart];
  const h2 = list[nonSpouseStart + 1];
  const page1AHeirs = list.slice(nonSpouseStart + 2);

  if (h1) { setText(form,'33',h1.full_name); setText(form,'34',h1.relationship?.short??''); setText(form,'35',fullAddr(addr(h1))); }
  if (h2) { setText(form,'36',h2.full_name); setText(form,'37',h2.relationship?.short??''); setText(form,'38',fullAddr(addr(h2))); }

  if (page1AHeirs.length > 10) {
    warnings.push(
      `Warning: Page 1A can hold 10 heirs but ${page1AHeirs.length} were found. ` +
      'Additional heirs must be added manually.'
    );
  }
  page1AHeirs.slice(0, 10).forEach((heir, i) => {
    const [nF, rF, a1F, a2F] = PAGE1A_GROUPS[i];
    const a = addr(heir);
    setText(form, nF,  heir.full_name);
    setText(form, rF,  heir.relationship?.short ?? '');
    setText(form, a1F, a.street ?? '');
    setText(form, a2F, a.city ? `${a.city}, ${a.state ?? ''} ${a.postal_code ?? ''}`.trim() : '');
  });

  return { bytes: await pdfDoc.save(), warnings };
}

module.exports = { fillPC11 };
