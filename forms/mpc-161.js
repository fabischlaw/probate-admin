'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, sumAssets, FIRM, safeMI, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0044';

async function fillMPC161(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const repAddr = addr(rep);
  const warnings = [];
  if (!dec) warnings.push('MPC-161: No decedent contact found');

  const hasWill           = !!toggleAnswers.hasWill;
  const renunciation      = !!toggleAnswers.renunciation;
  const suretyWaived      = !!toggleAnswers.suretyWaived;
  const willWaivesSureties = !!toggleAnswers.willWaivesSureties;
  const bondAmount        = toggleAnswers.bondAmount   || '';
  const willDate          = toggleAnswers.willDate     || '';
  const codicilDates      = toggleAnswers.codicilDates || '';
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const repName = rep ? `${rep.first_name || ''} ${rep.last_name || ''}`.trim() : '';

  const d = {
    docketNo:   matter.docket_no || '',
    division,
    // header
    decLn:      dec?.last_name   || '',
    decFn:      dec?.first_name  || '',
    decMn:      dec?.middle_name || '',
    dod:        formatDate(dec?.date_of_death),
    // Q2 petitioner
    repLn:      rep?.last_name   || '',
    repFn:      rep?.first_name  || '',
    repMi:      rep?.middle_name || '',
    repStreet:  repAddr?.street      || '',
    repCity:    repAddr?.city        || '',
    repState:   repAddr?.state       || '',
    repZip:     repAddr?.postal_code || '',
    repPhone:   phone(rep),
    // will
    hasWill, willDate, codicilDates,
    // bond
    bondAmount, suretyWaived, willWaivesSureties,
    // priority
    renunciation,
    // sig
    sigDate, repName,
    // firm
    firm: {
      name:   FIRM.name,
      bbo:    FIRM.bbo || '',
      street: FIRM.street,
      city:   FIRM.city,
      state:  FIRM.state,
      zip:    FIRM.zip,
      phone:  FIRM.phone,
      email:  FIRM.email,
    },
  };

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
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

    // Header
    set('DocketNo_6',        d.docketNo);
    set('TextField4_8',      d.decLn);
    set('TextField4_9',      d.decFn);
    set('TextField4_10',     d.decMn);
    set('DateTimeField1_11', d.dod);
    set('DropDownList1_16',  d.division);

    // Q1 – death certificate
    set('Q1_DCinCourt_52', true);

    // Q2 – petitioner
    set('TextField4_61',  d.repLn);
    set('TextField4_63',  d.repFn);
    set('TextField4_64',  d.repMi);
    set('TextField4_65',  d.repStreet);
    set('TextField4_66',  d.repCity);
    set('TextField4_67',  d.repState);
    set('TextField5_68',  d.repZip);
    set('Phone_78',       d.repPhone);

    // Q4 – domicile / venue
    set('Q4_DomiciledInCounty_90', true);

    // Q7 – will / intestate
    set('Q7_IntestateWithoutWill_112',  !d.hasWill);
    set('Q7_TestateWithWill_121',        d.hasWill);
    set('Q7_TestateWithWillDate_119',    d.willDate);
    set('TextField6_120',               d.codicilDates);
    set('Q7_TestateOrigInCourt_125',    d.hasWill);

    // Q9 – personal representative (self only)
    set('Q9_PetRequest_SelfOnly_187', true);
    set('TextField4_192',  d.repLn);
    set('TextField4_193',  d.repFn);
    set('TextField4_194',  d.repMi);
    set('TextField4_196',  d.repStreet);
    set('TextField4_197',  d.repCity);
    set('TextField4_198',  d.repState);
    set('TextField5_195',  d.repZip);
    set('Phone_207',       d.repPhone);

    // Q10 – priority
    set('Q10_ByStatue_216',      !d.renunciation);
    set('Q10_ByRenunciation_215', d.renunciation);

    // Q11 – bond
    set('Q11_BondWithOutSureties_246',  true);
    set('Asset_249',                    d.bondAmount);
    set('Q11_AllWaivedSureties_250',    d.suretyWaived);
    set('Q11_WillWaivesSureties_245',   d.willWaivesSureties);

    // Signature block
    set('DateTimeField3_296',        d.sigDate);
    set('SignatureofPetitioner_297', d.repName);

    // Attorney block
    set('TextField5_299', d.firm.name);
    set('TextField6_300', d.firm.bbo);
    set('TextField5_301', d.firm.street);
    set('TextField5_302', d.firm.city);
    set('TextField5_303', d.firm.state);
    set('TextField5_304', d.firm.zip);
    set('TextField5_305', d.firm.phone);
    set('TextField4_306', d.firm.email);
  }, d);

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC161 };
