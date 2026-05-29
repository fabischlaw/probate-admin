// PC-1.5 Petition for Probate of Will
const { PDFDocument } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');
const {
  TEMPLATES_DIR, RESIDENT_AGENT,
  formatDate, sumAssets, isRI,
  addr, phone, email, fullAddr,
  setText, setCheckbox, drawX,
  fillHeader, identifyContacts,
} = require('./common');
const { buildHeirList } = require('../heirLogic');

const TEMPLATE = path.join(TEMPLATES_DIR, 'PC-1.5.pdf');

// Page 1A: 10 rows, 4 fields each [name, relationship, addr1, addr2]
const PAGE1A_GROUPS = [
  ['78','79','109','111'], ['112','114','115','116'], ['117','118','119','120'],
  ['121','122','123','124'], ['125','126','127','128'], ['129','130','131','132'],
  ['133','134','135','136'], ['137','138','139','140'], ['141','142','143','144'],
  ['145', null, '1030','1031'],
];

async function fillPC15(matter, contacts, assets, { petitionType = 'probate', selectedBeneficiaryIds = null } = {}) {
  const pdfDoc = await PDFDocument.load(fs.readFileSync(TEMPLATE));
  const form   = pdfDoc.getForm();

  const { decedent, representative } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  // Petition heir fields always show intestate heirs only, regardless of will beneficiaries
  const { list, hasSpouse, warnings } = buildHeirList(contacts, 'admin', null);

  const decedentCity = addr(decedent).city ?? matter.contact_main?.address1?.city;

  fillHeader(form,
    { decedentName: decedent?.full_name ?? matter.name, decedentCity },
    { countyField: 'Combo Box 2', cityField: 'Combo Box 3', estateField: '2', aliasField: '3', caseField: '5' }
  );

  setText(form, '6', decedent?.full_name);
  setText(form, '8', decedentCity);
  setText(form, '9', formatDate(decedent?.date_of_death ?? matter.contact_main?.date_of_death));
  setText(form, '7', sumAssets(assets));

  if (representative) {
    const a = addr(representative);
    const relEntry = contacts.find(c => c.id === representative.id);
    const relShort = relEntry?.relationship?.short ?? '';
    let petRel = relShort;
    if (!relShort || relShort.toLowerCase() === 'client') {
      warnings.push('Warning: Petitioner relationship to deceased is missing — please fill in manually before filing.');
      petRel = '';
    }

    setText(form, '10', representative.full_name);
    setText(form, '11', petRel);
    setText(form, '12', a.street ?? '');
    setText(form, '13', a.city   ?? '');
    setText(form, '14', a.state  ?? '');
    setText(form, '15', a.postal_code ?? '');
    setText(form, '16', email(representative));
    setText(form, '17', phone(representative));

    setCheckbox(form, 'Check Box1', true);

    // Nominee = petitioner
    setText(form, '19', representative.full_name);
    setText(form, '20', petRel);
    setText(form, '21', a.street ?? '');
    setText(form, '22', a.city   ?? '');
    setText(form, '23', a.state  ?? '');
    setText(form, '24', a.postal_code ?? '');
    setText(form, '25', email(representative));
    setText(form, '26', phone(representative));

    // Decree: Fiduciary = petitioner
    setText(form, '103', representative.full_name);
    setText(form, '104', a.street ?? '');
    setText(form, '105', a.city   ?? '');
    setText(form, '106', a.state  ?? '');
    setText(form, '107', a.postal_code ?? '');
    setText(form, '108', email(representative));
    setText(form, '1010', phone(representative));

    drawX(pdfDoc.getPages()[2], 148, 462);

    if (!isRI(a.state)) {
      setText(form, '1036', RESIDENT_AGENT.name);
      setText(form, '1037', RESIDENT_AGENT.street);
      setText(form, '1038', RESIDENT_AGENT.city);
      setText(form, '1039', RESIDENT_AGENT.state);
      setText(form, '1040', RESIDENT_AGENT.zip);
      setText(form, '1041', RESIDENT_AGENT.email);
      setText(form, '1042', RESIDENT_AGENT.phone);
    }
  }

  // --- Heir layout (same structure as PC-1.1) ---
  // Spouse row (35-36): filled if list[0] is a spouse
  // Two heir rows (37-42): next 2 from list
  // Page 1A: overflow, up to 10

  if (hasSpouse) {
    const s = list[0];
    setText(form, '35', s.full_name);
    setText(form, '36', fullAddr(addr(s)));
  }

  const nonSpouseStart = hasSpouse ? 1 : 0;
  const h1 = list[nonSpouseStart];
  const h2 = list[nonSpouseStart + 1];
  const page1AHeirs = list.slice(nonSpouseStart + 2);

  if (h1) { setText(form,'37',h1.full_name); setText(form,'38',h1.relationship?.short??''); setText(form,'39',fullAddr(addr(h1))); }
  if (h2) { setText(form,'40',h2.full_name); setText(form,'41',h2.relationship?.short??''); setText(form,'42',fullAddr(addr(h2))); }

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
    if (rF) setText(form, rF, heir.relationship?.short ?? '');
    setText(form, a1F, a.street ?? '');
    setText(form, a2F, a.city ? `${a.city}, ${a.state ?? ''} ${a.postal_code ?? ''}`.trim() : '');
  });

  return { bytes: await pdfDoc.save(), warnings };
}

module.exports = { fillPC15 };
