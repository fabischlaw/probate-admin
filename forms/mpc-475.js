'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0085';

async function fillMPC475(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const repAddr = addr(rep);
  const decAddr = addr(dec);
  const warnings = [];
  if (!dec) warnings.push('MPC-475: No decedent contact found');

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const dod = formatDate(dec?.date_of_death);
  const today = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
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

    // Header
    set('DocketNo_6',       d.docketNo);
    set('Ln_8',             d.dec?.last_name);
    set('Fn_9',             d.dec?.first_name);
    set('Mn_10',            d.dec?.middle_name);
    set('DoB_ate_11',       d.dod);
    set('ddl_Division_12',  d.division);

    // Petitioner (affiant)
    set('txt_3_Fn_23',      d.rep?.first_name);
    set('txt_3_Ln_24',      d.rep?.last_name);
    set('txt_3_Mi_25',      d.rep?.middle_name || '');

    // Signature dates
    set('DateTimeField4_34', d.sigDate);
    set('DateTimeField5_35', d.sigDate);

    // Petitioner print name and address
    set('txt_PetPrintName_42', d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
    set('txt_PetAddr_46',      d.repAddr?.street);
    set('txt_PetAptNo_47',     '');
    set('txt_PetCityTown_45',  d.repAddr?.city);
    set('txt_PetState_44',     d.repAddr?.state);
    set('txt_PetZip_43',       d.repAddr?.postal_code);
    set('txt_PetPphone_48',    d.repPhone);
    set('txt_PetSign_50',      d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
  }, {
    dec:      dec ? { first_name: dec.first_name, middle_name: dec.middle_name, last_name: dec.last_name } : null,
    rep:      rep ? { first_name: rep.first_name, middle_name: rep.middle_name, last_name: rep.last_name } : null,
    repAddr,
    repPhone: phone(rep),
    toggles:  toggleAnswers,
    docketNo: matter.docket_no || '',
    division,
    dod, sigDate,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC475 };
