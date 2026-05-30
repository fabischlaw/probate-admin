'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, email, formatDate, identifyContacts, FIRM, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0007';

async function fillMPC170(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const repAddr = addr(rep);
  const warnings = [];
  if (!dec) warnings.push('MPC-170: No decedent contact found');

  const hasWill    = !!toggleAnswers.hasWill;
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  // Determine "no real estate" flag
  const hasRealEstate  = !!toggleAnswers.hasRealEstate;
  const noRealEstate   = !!toggleAnswers.noRealEstate || !hasRealEstate;

  // Build up to 4 asset rows
  const assetRows = (assets || []).slice(0, 4).map(a => ({
    desc:   a.description || a.asset_type || '',
    amount: a.net_value
      ? '$' + parseFloat(a.net_value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '',
  }));

  const totalValue = (assets || []).reduce((s, a) => s + parseFloat(a.net_value || 0), 0);
  const totalStr   = totalValue > 0
    ? '$' + totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';

  if ((assets || []).length > 4) {
    warnings.push('MPC-170: More than 4 assets — only first 4 fit on form');
  }

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
    // Q1 decedent address
    decStreet:  decAddr?.street      || '',
    decCity:    decAddr?.city        || '',
    decState:   decAddr?.state       || '',
    decZip:     decAddr?.postal_code || '',
    // Q2 petitioner / affiant
    repLn:      rep?.last_name   || '',
    repFn:      rep?.first_name  || '',
    repMi:      rep?.middle_name || '',
    repStreet:  repAddr?.street      || '',
    repCity:    repAddr?.city        || '',
    repState:   repAddr?.state       || '',
    repZip:     repAddr?.postal_code || '',
    repPhone:   phone(rep),
    repEmail:   email(rep),
    firm: {
      name:   FIRM.name,
      bbo:    FIRM.bbo || '',
      street: FIRM.street,
      city:   FIRM.city,
      state:  FIRM.state,
      zip:    FIRM.zip,
      phone:  FIRM.phone,
    },
    // flags
    hasWill, noRealEstate,
    // assets
    assetRows, totalStr,
    // sig
    sigDate, repName,
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
    set('DocketNo_6',       d.docketNo);
    set('Ln_8',             d.decLn);
    set('Fn_9',             d.decFn);
    set('Mn_10',            d.decMn);
    set('DateTimeField1_11',d.dod);
    set('DropDownList1_12', d.division);

    // Q1 – Decedent (probe-confirmed: 14=Last, 15=Middle, 16=First, 25=AKA, 30=Street, 31=City, 32=State, 33=Zip)
    set('TextField4_14', d.decLn);
    set('TextField4_15', d.decMn);
    set('TextField4_16', d.decFn);
    set('TextField4_25', '');           // AKA — no DV field
    set('TextField4_30', d.decStreet);
    set('TextField4_31', d.decCity);
    set('TextField4_32', d.decState);
    set('TextField4_33', d.decZip);

    // Q2 – Petitioner / affiant (probe-confirmed: 39=Last, 40=First, 41=Middle, 42=Street, 46=City, 43=State, 44=Zip)
    set('TextField4_39', d.repLn);
    set('TextField4_40', d.repFn);
    set('TextField4_41', d.repMi);
    set('TextField4_42', d.repStreet);
    set('TextField4_46', d.repCity);
    set('TextField4_43', d.repState);
    set('TextField4_44', d.repZip);
    set('Phone_52',      d.repPhone);
    set('TextField4_53', d.repEmail);

    // Will / intestate checkboxes
    set('CheckBox1_63', d.hasWill);
    set('CheckBox1_64', !d.hasWill);

    // Real estate flag
    set('CheckBox1_73', d.noRealEstate);

    // Asset rows (4 fixed slots)
    const rows = [
      { desc: 'Desc_93',  amt: 'Amount_94'  },
      { desc: 'Desc_96',  amt: 'Amount_97'  },
      { desc: 'Desc_99',  amt: 'Amount_100' },
      { desc: 'Desc_102', amt: 'Amount_103' },
    ];
    d.assetRows.forEach((a, i) => {
      set(rows[i].desc, a.desc);
      set(rows[i].amt,  a.amount);
    });
    set('Total1_106', d.totalStr);

    // Signature block
    set('SignatureOfPetitioner_169',   d.repName);
    set('DateSignatureOfPetitioner_170', d.sigDate);

    // Attorney block (probe-confirmed: 172=name, 173=BBO, 175=street, 176=city, 177=state, 178=zip, 179=phone)
    set('TextField5_172', d.firm.name);
    set('TextField6_173', d.firm.bbo);
    set('TextField5_175', d.firm.street);
    set('TextField5_176', d.firm.city);
    set('TextField5_177', d.firm.state);
    set('TextField5_178', d.firm.zip);
    set('TextField4_179', d.firm.phone);
  }, d);

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC170 };
