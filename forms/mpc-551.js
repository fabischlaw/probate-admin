'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');
const { getChromePath } = require('../config/chromeConfig');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0025';

async function fillMPC551(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-551: No decedent contact found');
  if (!rep)  warnings.push('MPC-551: No representative contact found');
  if (!toggleAnswers.publicationNewspaper) {
    warnings.push('MPC-551: publicationNewspaper not set in toggleAnswers');
  }

  const repAddr = addr(rep);
  const decAddr = addr(dec);

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const chromePath = getChromePath();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
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
    set('DocketNo_4',      d.docketNo);
    set('TextField4_7',    d.dec?.first_name);
    set('TextField4_8',    d.dec?.middle_name);
    set('TextField4_9',    d.dec?.last_name);
    set('TextField4_11',   '');          // AKA — blank
    set('DropDownList1_12', d.division);

    // Date of death
    set('DateTimeField3_14', d.dod);

    // PR info (primary)
    set('FN_19',       d.rep?.first_name);
    set('MI_20',       d.rep?.middle_name);
    set('LN_21',       d.rep?.last_name);
    set('cityTown_22', d.repAddr?.city);
    set('State_23',    d.repAddr?.state);

    // Will / appointment
    set('Will_29', d.toggles.hasWill);
    set('appt_32', true);

    // PR info copy
    set('FN_33',       d.rep?.first_name);
    set('MI_34',       d.rep?.middle_name);
    set('LN_35',       d.rep?.last_name);
    set('cityTown_36', d.repAddr?.city);
    set('State_37',    d.repAddr?.state);

    // Publication type radio — index 0 = formal newspaper (default)
    const radios = document.querySelectorAll('[name="RadioButtonList_44"]');
    if (radios.length >= 1) {
      radios[0].checked = true;
      radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, {
    docketNo:  matter.docket_no || '',
    division,
    dod:       formatDate(dec?.date_of_death || ''),
    sigDate,
    toggles:   toggleAnswers,
    dec: dec ? {
      first_name:  dec.first_name,
      middle_name: dec.middle_name || '',
      last_name:   dec.last_name,
    } : null,
    rep: rep ? {
      first_name:  rep.first_name,
      middle_name: rep.middle_name || '',
      last_name:   rep.last_name,
    } : null,
    repAddr,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC551 };
