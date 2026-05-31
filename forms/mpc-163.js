'use strict';
const puppeteer = require('puppeteer');
const { addr, formatDate, identifyContacts, fullAddr, getMatterCaption, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');
const { generateContinuationPages, mergeWithContinuation } = require('./maContinuationPage');
const { getChromePath } = require('../config/chromeConfig');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0016';

// Professional / non-devisee types; 0CLNT kept (client can be a will beneficiary)
const PROF_TYPES = new Set([
  '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
  '4CONT', '1MAIN', '1DIVO',
]);

const FORM_SLOTS = 3; // Q2 has three named-devisee rows on the court form

async function fillMPC163(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-163: No decedent contact found');
  if (!toggleAnswers.hasWill) warnings.push('MPC-163: MPC-163 is for testate estates only');

  const hasWill      = !!toggleAnswers.hasWill;
  const willDate     = toggleAnswers.willDate     || '';
  const codicilDates = toggleAnswers.codicilDates || '';
  const isAmended    = !!toggleAnswers.isAmended;
  const decAddr = addr(dec);
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const deviseeContacts = contacts.filter(c =>
    !PROF_TYPES.has(c.relationship?.type) && c.id !== dec?.id
  );

  function mapDevisee(c) {
    const a = addr(c);
    return {
      name:         c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      address:      fullAddr(a),
      relationship: c.relationship?.short || c.relationship?.type || '',
      interest:     toggleAnswers[`deviseeInterest_${c.id}`] || '',
      isMinor:      !!toggleAnswers[`minor_${c.id}`],
    };
  }

  const onFormDevisees  = deviseeContacts.slice(0, FORM_SLOTS).map(mapDevisee);
  const overflowDevises = deviseeContacts.slice(FORM_SLOTS).map(mapDevisee);

  if (overflowDevises.length > 0) {
    warnings.push(
      `MPC-163: ${deviseeContacts.length} devisees — first ${FORM_SLOTS} on court form, ` +
      `${overflowDevises.length} on continuation sheet.`
    );
  }

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const repName = rep ? `${rep.first_name || ''} ${rep.last_name || ''}`.trim() : '';

  const d = {
    docketNo: matter.docket_no || '',
    division, isAmended,
    decLn: dec?.last_name   || '',
    decFn: dec?.first_name  || '',
    decMn: dec?.middle_name || '',
    dod:   formatDate(dec?.date_of_death),
    hasWill, willDate, codicilDates,
    hasCodicils: !!codicilDates,
    deviseeData: onFormDevisees,
    sigDate, repName,
  };

  const chromePath = getChromePath();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="DocketNo_6"]', { timeout: 10000 }); } catch (_) {}
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

    set('DocketNo_6',     d.docketNo);
    set('LastName_9',     d.decLn);
    set('FirstName_10',   d.decFn);
    set('MiddleName_11',  d.decMn);
    set('DateOfDeath_12', d.dod);
    set('Division_13',    d.division);
    set('OriginalForm_7', !d.isAmended);
    set('AmendedForm_14', d.isAmended);

    set('Q1_DecedentWillDate_27',   d.willDate);
    set('Q1_DatesOfAllCodicils_22', d.hasCodicils);
    set('Q1_CodicilDates_25',       d.codicilDates);

    const slots = [
      { name: 'Q2_NameOfdevisee_40', addr: 'Q2_Address_41', rel: 'Q2_RelationshipToDecedent_42', minor: 'Q2_YesMinor_44' },
      { name: 'Q2_NameOfdevisee_46', addr: 'Q2_Address_47', rel: 'Q2_RelationshipToDecedent_48', minor: 'Q2_YesMinor_50' },
      { name: 'Q2_NameOfdevisee_52', addr: 'Q2_Address_53', rel: 'Q2_RelationshipToDecedent_54', minor: 'Q2_YesMinor_56' },
    ];

    d.deviseeData.forEach((dev, i) => {
      if (i >= slots.length) return;
      const s = slots[i];
      set(s.name,  dev.name);
      set(s.addr,  dev.address);
      set(s.rel,   dev.relationship);
      set(s.minor, dev.isMinor);
    });

    set('DateSignatureOfPetitioner_188', d.sigDate);
    set('PrintName_189',                 d.repName);
    set('SignatureOfPetitioner_190',     d.repName);
  }, d);

  const mainBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();

  // ── Continuation pages for overflow devisees ───────────────────────────────
  let finalBytes = mainBytes;
  if (overflowDevises.length > 0) {
    const caption = getMatterCaption(matter, contacts, division);
    const contBytes = await generateContinuationPages({
      formId:               '163',
      formTitle:            'Devisees',
      decedentName:         caption.decedentName,
      docketNumber:         caption.docketNumber,
      county:               caption.county,
      columns: [
        { header: 'Name',                    key: 'name',         width: '30%' },
        { header: 'Address',                 key: 'address',      width: '35%' },
        { header: 'Relationship',            key: 'relationship', width: '15%' },
        { header: 'Nature of Interest',      key: 'interest',     width: '20%' },
      ],
      entries:              overflowDevises,
      startingEntryNumber:  FORM_SLOTS + 1,
      pageNumberOffset:     2,
    });
    finalBytes = await mergeWithContinuation(mainBytes, contBytes);
  }

  return { bytes: finalBytes, warnings };
}

module.exports = { fillMPC163 };
