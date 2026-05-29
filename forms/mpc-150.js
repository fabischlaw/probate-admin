'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, email, formatDate, identifyContacts, sumAssets, FIRM, safeMI, calculateAgeAtDeath, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0010';

async function fillMPC150(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-150: No decedent contact found');
  if (!rep)  warnings.push('MPC-150: No representative/petitioner contact found');

  const repAddr = addr(rep);
  const decAddr = addr(dec);
  const dod = formatDate(dec?.date_of_death);
  const today = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const bondAmount = toggleAnswers.bondAmount || sumAssets(assets) || '';
  const ageAtDeath = calculateAgeAtDeath(dec?.date_of_birth, dec?.date_of_death);
  const petRelArray = toggleAnswers.petitionerRelationships;
  const petInterest = (Array.isArray(petRelArray) && petRelArray.length > 0)
    ? petRelArray.join(', ')
    : 'Personal Representative';

  // Division: auto-determine from decedent's city; fall back to toggleAnswers.maCounty → division
  const autoCounty   = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');
  if (!autoCounty && !toggleAnswers.maCounty && !toggleAnswers.division) {
    warnings.push('MPC-150: Could not determine MA division from decedent address — set "County of decedent\'s domicile" in Case Facts.');
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="LnName_7"]', { timeout: 10000 }); } catch(_) {}
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
    // Quiet set: assigns checkbox without dispatching events, bypassing form JS cascades
    function setQ(name, val) {
      const el = document.querySelector('[name="' + name + '"]');
      if (el) el.checked = !!val;
    }

    // Header
    set('TextField4_5',  d.docketNo);
    set('LnName_7',      d.dec?.last_name);
    set('FnName_8',      d.dec?.first_name);
    set('MdName_9',      d.dec?.middle_name);
    set('DateOfDeath_10', d.dod);
    set('Division_16',   d.division);
    // CheckBox1_17 = Amended Form, CheckBox1_18 = Original Form (probe-confirmed)
    setQ('CheckBox1_17', !!d.toggles.isAmended);
    setQ('CheckBox1_18', !d.toggles.isAmended);

    // Top-of-form petition type checkboxes (probe: CheckBox1_12, CheckBox1_13)
    // CheckBox1_12 = "Petition for Informal Probate of a Will" (testate only)
    // CheckBox1_13 = "Petition for Informal Appointment of Personal Representative" (always)
    setQ('CheckBox1_12', d.hasWill);
    setQ('CheckBox1_13', true);

    // Q1 – Decedent details
    set('Q1_LnName_21',        d.dec?.last_name);
    set('Q1_MdName_22',        d.dec?.middle_name);
    set('Q1_FnName_23',        d.dec?.first_name);
    set('Q1_AgeOfDeath_30',    d.ageAtDeath);
    set('Q1_DomiciledInCity_41',  d.decAddr?.city);
    set('Q1_DomiciledInState_42', d.decAddr?.state);
    set('Q1_Address_48',          d.decAddr?.street);
    set('Q1_City_46',             d.decAddr?.city);
    set('Q1_State_45',            d.decAddr?.state);
    set('Q1_Zip_44',              d.decAddr?.postal_code);

    // Q2 – Petitioner
    set('Q2_LnName_57',            d.rep?.last_name);
    set('Q2_FnName_59',            d.rep?.first_name);
    set('Q2_MI_60',                d.rep?.middle_name || '');
    set('Q2_Address_61',           d.repAddr?.street);
    set('Q2_CityTown_62',          d.repAddr?.city);
    set('Q2_State_63',             d.repAddr?.state);
    set('Q2_Zip_64',               d.repAddr?.postal_code);
    set('Q2_Phone_74',             d.repPhone);
    set('Q2_Phone_77',             d.repEmail);
    set('Q2_PetitionerIterest_76', d.petInterest);

    // Q4 – Domicile
    set('Q4_DomiciledInCounty_93', true);

    // Item 5 – DMA notice
    set('CheckBox1_102', true);

    // Q7 – Will / intestate
    // Bug 5: use quiet-set — form JS cascades both when either is set via events
    const hasWill = !!d.toggles.hasWill;
    setQ('Q7_IntestateWithoutWill_114', !hasWill);
    setQ('Q7_IntestateWithWill_121',    hasWill);
    if (hasWill) {
      set('Q7_DecedentLastWillDate_123', d.toggles.willDate || '');
      set('Q7_DatesOfAllCodicils_124',   d.toggles.codicilDates || '');
      set('Q7_WillInPossession_133',     true);
    }

    // Q8 – PR appointment
    set('CheckBox1_143',    true);
    set('Q8_SelfOnly_146',  true);
    set('Q8_LnName_150',    d.rep?.last_name);
    set('Q8_MI_151',        d.rep?.middle_name || '');
    set('Q8_FnName_152',    d.rep?.first_name);
    set('Q8_Address_157',   d.repAddr?.street);
    set('Q8_CityTown_155',  d.repAddr?.city);
    set('Q8_State_154',     d.repAddr?.state);
    set('Q8_Zip_153',       d.repAddr?.postal_code);
    set('Q8_MailPhone_165', d.repPhone);

    // Q9 – Priority: quiet-set (cascades like Q7)
    setQ('Q9_ByStatute_174',      !d.toggles.priorityByRenunciation);
    setQ('Q9_ByRenunciation_173', !!d.toggles.priorityByRenunciation);

    // Q10 – No court-appointed rep
    set('Q10_NoCourtAppointed_186', true);

    // Q11 – Bond
    set('Q11_BondWithOutSureties_204', true);
    set('Asset_208',                   d.bondAmount);
    set('Q11_AllDeviseesWavedSureties_209', !!d.toggles.suretyWaived);
    set('Q11_WillWavesSureties_210',        !!d.toggles.willWaivesSureties);

    // §V Relief Requested — all four cascade; use setQ throughout
    // CheckBox1_217 = Admit will (testate only); setQ prevents cascade from CheckBox1_218
    // CheckBox1_218 = Appoint nominee as PR
    // CheckBox1_220 = without sureties / CheckBox1_221 = with sureties
    setQ('CheckBox1_217', d.hasWill);
    set('CheckBox1_218', true);
    setQ('CheckBox1_220', !d.bondWithSureties);
    setQ('CheckBox1_221', !!d.bondWithSureties);

    // Signature
    set('PetDate_229',  d.sigDate);
    set('PetSign_231',  d.rep ? (d.rep.first_name + ' ' + d.rep.last_name).trim() : '');

    // Attorney info (probe-confirmed field layout)
    // 233=name, 239=address, 240=apt, 238=city, 237=state, 236=zip,
    // 235=primary phone (TextField7_ prefix!), 234=BBO#, 243=email
    set('TextField5_233', d.firm.name);
    set('TextField5_239', d.firm.street);
    set('TextField4_240', '');
    set('TextField5_238', d.firm.city);
    set('TextField5_237', d.firm.state);
    set('TextField5_236', d.firm.zip);
    set('TextField7_235', d.firm.phone);
    set('TextField6_234', d.firm.bbo);
    set('TextField6_243', d.firm.email);
  }, {
    dec:      dec ? { first_name: dec.first_name, middle_name: safeMI(dec), last_name: dec.last_name } : null,
    rep:      rep ? { first_name: rep.first_name, middle_name: safeMI(rep), last_name: rep.last_name } : null,
    repAddr,  decAddr,
    repPhone: phone(rep),
    repEmail: email(rep),
    toggles:  toggleAnswers,
    docketNo: matter.docket_no || '',
    division,
    dod, bondAmount, sigDate,
    ageAtDeath:       ageAtDeath !== null ? String(ageAtDeath) : '',
    petInterest,
    hasWill:          !!toggleAnswers.hasWill,
    bondWithSureties: !!toggleAnswers.bondWithSureties,
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
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC150 };
