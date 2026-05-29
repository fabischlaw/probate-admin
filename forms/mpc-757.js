'use strict';
const puppeteer = require('puppeteer');
const { addr, formatDate, identifyContacts, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0100';

// MPC-757 is a court-issued decree for Late & Limited proceedings — pre-fill header only.
async function fillMPC757(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const warnings = [];
  if (!dec) warnings.push('MPC-757: No decedent contact found');

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="DocketNo_4"]', { timeout: 10000 }); } catch (_) {}
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
    set('DocketNo_4',       d.docketNo);
    set('Ln_8',             d.dec?.last_name);
    set('Fn_9',             d.dec?.first_name);
    set('Mn_10',            d.dec?.middle_name);
    set('DropDownList1_11', d.division);
    set('dod_12',           '');           // AKA — blank
    set('TextField4_13',    d.dod);

    // Testate / intestate
    set('CheckBox1_27', !!d.toggles.hasWill);   // testate
    set('CheckBox1_24', !d.toggles.hasWill);     // intestate
    if (d.toggles.hasWill && d.willDate) {
      set('TextField4_25', d.willDate);
    }

    // Appointment
    set('CheckBox1_43', true);

    // PR reference
    set('TextField4_45', d.rep?.last_name);
  }, {
    docketNo: matter.docket_no || '',
    division,
    dod:      formatDate(dec?.date_of_death || ''),
    willDate: toggleAnswers.willDate ? formatDate(toggleAnswers.willDate) : '',
    toggles:  toggleAnswers,
    dec: dec ? {
      first_name:  dec.first_name,
      middle_name: dec.middle_name || '',
      last_name:   dec.last_name,
    } : null,
    rep: rep ? {
      last_name: rep.last_name,
    } : null,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC757 };
