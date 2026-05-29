'use strict';
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { addr, formatDate, identifyContacts, fullAddr, getMatterCaption, NON_HEIR_TYPES, safeMI, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');
const { generateContinuationPages, mergeWithContinuation } = require('./maContinuationPage');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0009';

const CHILD_TYPES    = new Set(['2SON','2DATR']);
const GRANDCHILD_TYPES = new Set(['3GSON','3GDTR']);
const PARENT_TYPES   = new Set(['3FATH','3MOTH']);
const SIBLING_TYPES  = new Set(['3BROT','3SIST','3SIBL']);
const SPOUSE_ACTUAL  = new Set(['1MARR','1WIDW','3LIFP']);

const CHILD_SLOTS   = 3;
const PARENT_SLOTS  = 2;
const SIBLING_SLOTS = 2;
const EXTRA_SLOTS   = 2;

function relLabel(type) {
  const map = {
    '1MARR':'Spouse','1WIDW':'Surviving Spouse','3LIFP':'Domestic Partner',
    '2SON':'Son','2DATR':'Daughter','2SSON':'Stepson','2SDTR':'Stepdaughter',
    '3GSON':'Grandson','3GDTR':'Granddaughter',
    '3FATH':'Father','3MOTH':'Mother',
    '3BROT':'Brother','3SIST':'Sister','3SIBL':'Sibling',
    '3AUNT':'Aunt','3UCLE':'Uncle','3NIEC':'Niece','3NEPW':'Nephew','3COUS':'Cousin',
    '3OTHE':'Other Relative','4FRIE':'Friend',
  };
  return map[type] || type || '';
}

function getAgeIfMinor(c) {
  if (!c.date_of_birth) return '';
  const dob = new Date(c.date_of_birth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age < 18 ? `Minor (age ${age})` : '';
}

async function fillMPC162(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const warnings = [];
  if (!dec) warnings.push('MPC-162: No decedent contact found');

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const dod = formatDate(dec?.date_of_death);
  const today = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const nonDecContacts = contacts.filter(c =>
    c.id !== dec?.id && !NON_HEIR_TYPES.has(c.relationship?.type)
  );

  const spouseContact  = nonDecContacts.find(c => SPOUSE_ACTUAL.has(c.relationship?.type));
  const children       = nonDecContacts.filter(c => CHILD_TYPES.has(c.relationship?.type));
  const grandchildren  = nonDecContacts.filter(c => GRANDCHILD_TYPES.has(c.relationship?.type));
  const parents        = nonDecContacts.filter(c => PARENT_TYPES.has(c.relationship?.type));
  const siblings       = nonDecContacts.filter(c => SIBLING_TYPES.has(c.relationship?.type));
  const otherHeirs     = nonDecContacts.filter(c =>
    !SPOUSE_ACTUAL.has(c.relationship?.type) &&
    !CHILD_TYPES.has(c.relationship?.type) &&
    !GRANDCHILD_TYPES.has(c.relationship?.type) &&
    !PARENT_TYPES.has(c.relationship?.type) &&
    !SIBLING_TYPES.has(c.relationship?.type)
  );

  function contactRow(c) {
    const a = addr(c);
    return {
      name:    c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      address: fullAddr(a),
      rel:     relLabel(c.relationship?.type),
      dob:     formatDate(c.date_of_birth),
      dod_c:   formatDate(c.date_of_death),
    };
  }

  const childRows   = children.map(contactRow);
  const parentRows  = parents.map(contactRow);
  const siblingRows = siblings.map(contactRow);
  const extraRows   = [...grandchildren, ...otherHeirs].map(contactRow);
  const spouseRow   = spouseContact ? contactRow(spouseContact) : null;

  // ── Collect overflow heirs (mirror the form's conditional display logic) ───
  function mapOverflow(c) {
    const a = addr(c);
    return {
      name:         c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      address:      fullAddr(a),
      relationship: relLabel(c.relationship?.type),
      ageIfMinor:   getAgeIfMinor(c),
    };
  }

  const overflowHeirs = [];
  children.slice(CHILD_SLOTS).forEach(c => overflowHeirs.push(mapOverflow(c)));
  if (children.length === 0) {
    parents.slice(PARENT_SLOTS).forEach(c => overflowHeirs.push(mapOverflow(c)));
  }
  if (children.length === 0 && parents.length === 0) {
    siblings.slice(SIBLING_SLOTS).forEach(c => overflowHeirs.push(mapOverflow(c)));
  }
  [...grandchildren, ...otherHeirs].slice(EXTRA_SLOTS).forEach(c => overflowHeirs.push(mapOverflow(c)));

  if (overflowHeirs.length > 0) {
    warnings.push(
      `MPC-162: ${overflowHeirs.length} heir(s) exceed form slots — listed on continuation sheet.`
    );
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="DocketNo_6"]', { timeout: 10000 }); } catch(_) {}
  await new Promise(r => setTimeout(r, 1500));

  await page.evaluate((d) => {
    function set(name, val) {
      const el = document.querySelector('[name="' + name + '"]');
      if (!el) return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = !!val;
      } else if (el.tagName === 'SELECT') {
        const v = (val || '').toString().toLowerCase();
        const opt = Array.from(el.options).find(o =>
          o.value.toLowerCase() === v || o.text.toLowerCase() === v);
        if (opt) el.value = opt.value;
      } else {
        el.value = val || '';
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
    function setQ(name, val) {
      const el = document.querySelector('[name="' + name + '"]');
      if (el) el.checked = !!val;
    }

    // Header — court form stores Last/First/Middle in fields 10/11/12
    set('DocketNo_6',       d.docketNo);
    set('TextField4_10',    d.dec?.last_name);
    set('TextField4_11',    d.dec?.first_name);
    set('TextField4_12',    d.dec?.middle_name);
    set('DateTimeField1_13', d.dod);
    set('DropDownList1_14', d.division);
    // Header Original/Amended — probe confirmed: 7=Original, 8=Amended (opposite order from MPC-150)
    setQ('CheckBox1_7', !d.toggles.amendedForm);
    setQ('CheckBox1_8', !!d.toggles.amendedForm);

    // Q1 – Surviving spouse
    // Field 23 = "did not leave a surviving spouse"; field 24 = "left a surviving spouse"
    if (d.spouseRow) {
      set('Q1_LeftSurvivingSpouse_24',  true);
      set('Q1_SurvivingSpouseName_31',  d.spouseRow.name);
      set('Q1_Address_32',              d.spouseRow.address);
    } else {
      set('Q1_LeaveSurvivingSpouse_23', true);
    }

    // Q2 – Children
    if (d.childRows.length > 0) {
      set('Q2a_DecedentChildren_38', true);
      const slots = [
        ['Cell1_47','Cell2_48','Q2_No_50','Q2_Yes_51','Q2_MinorYes_53'],
        ['Cell1_55','Cell2_56','Q2_No_58','Q2_Yes_59','Q2_MinorYes_61'],
        ['Cell1_63','Cell2_64','Q2_No_66','Q2_Yes_67','Q2_MinorYes_69'],
      ];
      d.childRows.slice(0, 3).forEach((row, i) => {
        const [nameF, addrF, noF, yesF] = slots[i];
        set(nameF, row.name);
        set(addrF, row.address);
        // Q2 "Child of Surviving Spouse" Yes/No: DV does not capture this relationship,
        // so leave both blank rather than guess. These cascade when set via events — use setQ.
        setQ(noF,  false);
        setQ(yesF, false);
      });
    } else {
      set('Q2a_DecedentNoChildren_36', true);
    }

    // Q3 – All children survived decedent (simplification)
    if (d.childRows.length > 0) {
      set('Q3a_SurvivedDecedent_77', true);
    }

    // Q4 – Parents (if no descendants)
    if (d.childRows.length === 0) {
      if (d.parentRows.length > 0) {
        set('Q4_DecedentLeftSurvParent_129', true);
        const pSlots = [
          ['Cell1_136','Cell2_137'],
          ['Cell1_139','Cell2_140'],
        ];
        d.parentRows.slice(0,2).forEach((row, i) => {
          set(pSlots[i][0], row.name);
          set(pSlots[i][1], row.address);
        });
      } else {
        set('Q4_DecedentDidNotLeaveSurvParent_128', true);
      }
    }

    // Q5 – Siblings (if no descendants and no parents)
    if (d.childRows.length === 0 && d.parentRows.length === 0) {
      if (d.siblingRows.length > 0) {
        set('Q5a_DecedentLeft_147', true);
        const sSlots = [
          ['Cell1_162','Cell2_163','Q5a_MinorYes_165'],
          ['Cell1_167','Cell2_168','Q5a_MinorYes_170'],
        ];
        d.siblingRows.slice(0,2).forEach((row, i) => {
          set(sSlots[i][0], row.name);
          set(sSlots[i][1], row.address);
        });
      } else {
        set('Q5a_DecedentDidNotLeave_146', true);
      }
    }

    // Q6 – Additional heirs / general heirs at law
    const extras = d.extraRows;
    if (extras.length > 0) {
      set('Q6_heirsAtLaw_199', true);
      const eSlots = [
        ['Cell1_212','Cell1_213','Cell1_214','CheckBox1_216'],
        ['Cell1_218','Cell1_219','Cell1_220','CheckBox1_222'],
      ];
      extras.slice(0,2).forEach((row, i) => {
        set(eSlots[i][0], row.name);
        set(eSlots[i][1], row.address);
        set(eSlots[i][2], row.rel);
      });
    }

    // Signature
    set('DateTimeField3_305',   d.sigDate);
    set('TextField5_306',       d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
    set('PetitionerSignature_307', d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
  }, {
    dec:        dec ? { first_name: dec.first_name, middle_name: safeMI(dec), last_name: dec.last_name } : null,
    rep:        rep ? { first_name: rep.first_name, middle_name: safeMI(rep), last_name: rep.last_name } : null,
    docketNo:   matter.docket_no || '',
    division,
    toggles:    toggleAnswers,
    dod, sigDate,
    spouseRow, childRows, parentRows, siblingRows, extraRows,
  });

  // pageRanges '1-3' drops the court form's blank "No more pages" 4th page
  const rawBytes  = await page.pdf({ format: 'Letter', printBackground: true, pageRanges: '1-3' });
  await browser.close();
  // Fallback: if browser ignored pageRanges and rendered >3 pages, trim with pdf-lib
  let mainBytes = Buffer.from(rawBytes);
  const chkDoc = await PDFDocument.load(rawBytes);
  if (chkDoc.getPageCount() > 3) {
    chkDoc.removePage(chkDoc.getPageCount() - 1);
    mainBytes = Buffer.from(await chkDoc.save());
  }

  // ── Continuation pages for overflow heirs ─────────────────────────────────
  let finalBytes = mainBytes;
  if (overflowHeirs.length > 0) {
    const caption  = getMatterCaption(matter, contacts, division);
    const contBytes = await generateContinuationPages({
      formId:              '162',
      formTitle:           'Heirs at Law',
      decedentName:        caption.decedentName,
      docketNumber:        caption.docketNumber,
      county:              caption.county,
      columns: [
        { header: 'Name',                        key: 'name',         width: '30%' },
        { header: 'Address',                     key: 'address',      width: '35%' },
        { header: 'Relationship to Decedent',    key: 'relationship', width: '20%' },
        { header: 'Age if Minor',                key: 'ageIfMinor',   width: '15%' },
      ],
      entries:             overflowHeirs,
      startingEntryNumber: 1,
      pageNumberOffset:    2,
    });
    finalBytes = await mergeWithContinuation(mainBytes, contBytes);
  }

  return { bytes: finalBytes, warnings };
}

module.exports = { fillMPC162 };
