'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');
const { getChromePath } = require('../config/chromeConfig');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0039';

async function fillMPC485(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const repAddr = addr(rep);
  const warnings = [];
  if (!dec) warnings.push('MPC-485: No decedent contact found');

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const dod = formatDate(dec?.date_of_death);
  const today = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const chromePath = getChromePath();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath || undefined,
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
    set('DocketNo_6',        d.docketNo);
    set('Ln_8',              d.dec?.last_name);
    set('Fn_9',              d.dec?.first_name);
    set('Mn_10',             d.dec?.middle_name);
    set('DateTimeField3_11', d.dod);
    set('DropDownList1_12',  d.division);

    // Affiant (petitioner / rep)
    set('FN_16',             d.rep?.first_name);
    set('LN_17',             d.rep?.last_name);
    set('MI_18',             d.rep?.middle_name || '');
    set('Relationship_21',   d.toggles.petitionerInterest || '');

    // Domicile address (decedent's)
    set('Domicile_Address_23',  d.decAddr?.street);
    set('Domicile_CityTown_24', d.decAddr?.city);
    set('Domicile_County_28',   d.division || d.toggles.county || '');

    // Checkboxes: domicile evidence
    set('OwnerOfProperty_30',  !!d.toggles.domicileOwner);
    set('ResideAtProperty_31', !!d.toggles.domicileResident);
    set('FiledIncomeTax_33',   !!d.toggles.domicileFiledTax);
    set('FiledIncomeTax_Year_34', d.toggles.domicileTaxYear || '');
    set('LivingAtAddress_36',  !!d.toggles.domicileLiving);
    set('DecedentResidence_37', !d.toggles.domicileLiving);

    // Decedent last address
    set('DecedentResidence_Address_40', d.decAddr?.street);
    set('DecedentResidence_CityTown_41', d.decAddr?.city);
    set('DecedentResidence_State_43',    d.decAddr?.state);
    set('DecedentResidence_Zip_44',      d.decAddr?.postal_code);

    // Signature
    set('DateSignature_63', d.sigDate);
    set('Address_65',       d.repAddr?.street);
    set('CityTown_67',      d.repAddr?.city);
    set('State_68',         d.repAddr?.state);
    set('Zip_69',           d.repAddr?.postal_code);
    set('PrintName_70',     d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
    set('PrimaryPhone_71',  d.repPhone);
    set('Signature_72',     d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');
  }, {
    dec:      dec ? { first_name: dec.first_name, middle_name: dec.middle_name, last_name: dec.last_name } : null,
    rep:      rep ? { first_name: rep.first_name, middle_name: rep.middle_name, last_name: rep.last_name } : null,
    decAddr, repAddr,
    repPhone: phone(rep),
    toggles:  toggleAnswers,
    division,
    docketNo: matter.docket_no || '',
    dod, sigDate,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC485 };
