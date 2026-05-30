'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0083';

// witnessOverride: { first_name, last_name, middle_name, addr, phoneNum }
// When not provided the form prints blank witness blocks for manual completion
async function fillMPC480(matter, contacts, assets, toggleAnswers = {}, witnessOverride = null) {
  const { decedent: dec } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const warnings = [];
  if (!dec) warnings.push('MPC-480: No decedent contact found');
  if (!toggleAnswers.willDate) warnings.push('MPC-480: willDate not set in toggleAnswers — will date will be blank');

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  // Default witness: first non-decedent, non-professional contact
  let witness = witnessOverride;
  if (!witness) {
    const { NON_HEIR_TYPES: nht } = require('./common');
    const w = contacts.find(c =>
      c.id !== dec?.id &&
      !['5ATTO','5CFP','5CPA','5OTHE','5PCP','5REAL','5WMAN','4CONT','0CLNT','1MAIN'].includes(c.relationship?.type)
    );
    if (w) {
      witness = {
        first_name:  w.first_name,
        last_name:   w.last_name,
        middle_name: w.middle_name || '',
        addr:        addr(w),
        phoneNum:    phone(w),
      };
    }
  }

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const willDate = toggleAnswers.willDate ? formatDate(toggleAnswers.willDate) : (toggleAnswers.willDateFormatted || '');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="DocketNo_5"]', { timeout: 10000 }); } catch (_) {}
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

    // Header
    set('DocketNo_5',       d.docketNo);
    set('Ln_7',             d.dec?.last_name);
    set('Fn_8',             d.dec?.first_name);
    set('Mn_9',             d.dec?.middle_name);
    set('DateTimeField3_10', d.dod);
    set('DropDownList1_11', d.division);

    // Witness info
    set('Lname_15', d.witness?.last_name);
    set('Fname_17', d.witness?.first_name);
    set('Mi_18',    d.witness?.middle_name);

    // Decedent (testator) in whose presence will was signed
    set('Ln_presenceOf_21', d.dec?.last_name);
    set('mi_presenceOf_22', d.dec?.middle_name);
    set('Fn_presenceOf_23', d.dec?.first_name);

    // Testator condition
    set('CheckBox1_30', !d.toggles.notSoundMind);

    // Will dates
    set('DateTimeField1_31', d.willDate);
    set('DateTimeField4_41', d.willDate);
    set('DateTimeField1_47', d.willDate);

    // Printed signature
    const witnessName = d.witness
      ? `${d.witness.first_name || ''} ${d.witness.last_name || ''}`.trim()
      : '';
    set('WitnessSign_49', witnessName);
  }, {
    docketNo: matter.docket_no || '',
    division,
    dod:      formatDate(dec?.date_of_death || ''),
    willDate,
    toggles:  toggleAnswers,
    sigDate,
    dec: dec ? {
      first_name:  dec.first_name,
      middle_name: dec.middle_name || '',
      last_name:   dec.last_name,
    } : null,
    witness: witness ? {
      first_name:  witness.first_name,
      last_name:   witness.last_name,
      middle_name: witness.middle_name || '',
    } : null,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC480 };
