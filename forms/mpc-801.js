'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, sumAssets, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0008';

// Convert a numeric string/value to English words (up to millions)
function toWords(numStr) {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (isNaN(n) || n === 0) return 'Zero';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
                 'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen',
                 'Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function say(x) {
    if (x === 0) return '';
    if (x < 20)  return ones[x];
    if (x < 100) return tens[Math.floor(x/10)] + (x % 10 ? ' ' + ones[x % 10] : '');
    return ones[Math.floor(x/100)] + ' Hundred' + (x % 100 ? ' ' + say(x % 100) : '');
  }
  const whole = Math.floor(n);
  let out = '';
  if (whole >= 1000000) { out += say(Math.floor(whole / 1000000)) + ' Million '; }
  const thousands = Math.floor((whole % 1000000) / 1000);
  if (thousands > 0)    { out += say(thousands) + ' Thousand '; }
  const remainder = whole % 1000;
  if (remainder > 0)    { out += say(remainder); }
  return out.trim() || 'Zero';
}

async function fillMPC801(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-801: No decedent contact found');
  if (!rep)  warnings.push('MPC-801: No representative/principal contact found');

  const repAddr = addr(rep);
  const decAddr = addr(dec);

  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  // Bond amount: prefer toggleAnswers.bondAmount, then fall back to estate value
  let bondAmount = toggleAnswers.bondAmount || '';
  if (!bondAmount) {
    const estateVal = sumAssets(assets);
    if (estateVal) bondAmount = estateVal;
  }
  const bondWords = bondAmount ? toWords(bondAmount) : '';

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

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
    set('DocketNo_6',       d.docketNo);
    set('Ln_12',            d.dec?.last_name);
    set('Fn_13',            d.dec?.first_name);
    set('Mn_14',            d.dec?.middle_name);
    set('bondno_15',        d.docketNo);
    set('DropDownList1_16', d.division);

    // Bond amounts
    set('DecimalField3_23', d.bondAmount);
    set('DecimalField1_26', d.bondAmount);

    // Principal (Personal Representative)
    set('Text_29', 'personally appeared');
    set('FN_30',       d.rep?.first_name);
    set('MI_31',       d.rep?.middle_name);
    set('LN_32',       d.rep?.last_name);
    set('A1_33',       d.repAddr?.street);
    set('Apt_34',      d.repAddr?.apt || '');
    set('cityTown_35', d.repAddr?.city);
    set('State_36',    d.repAddr?.state);
    set('zip_37',      d.repAddr?.postal_code);
    set('Phone_39',    d.repPhone);

    // Surety (only if suretyName provided)
    if (d.suretyName) {
      set('Text_42', d.suretyName);
      set('FN_43',   d.suretyName);   // full name in first-name field if no split available
    }

    // PR name / bond description body
    const repFull = d.rep ? `${d.rep.first_name || ''} ${d.rep.last_name || ''}`.trim() : '';
    set('TextField4_59', repFull);

    // Signature blocks (principal)
    set('DateTimeField1_61',    d.sigDate);
    set('SignatureAndTitle_62', repFull);
    set('DateTimeField1_64',    d.sigDate);
    set('SignatureAndTitle_65', repFull);

    // Bond amount as words (second page)
    set('bondno_122',    d.docketNo);
    set('TextField4_123', d.bondWords);
  }, {
    docketNo:   matter.docket_no || '',
    division,
    sigDate,
    bondAmount,
    bondWords,
    suretyName: toggleAnswers.suretyName || '',
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
    repPhone: phone(rep),
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC801 };
