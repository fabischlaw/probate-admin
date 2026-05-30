'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, email, formatDate, identifyContacts, sumAssets, FIRM, safeMI, calculateAgeAtDeath, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0015';

async function fillMPC160(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const decAddr = addr(dec);
  const repAddr = addr(rep);
  const warnings = [];
  if (!dec) warnings.push('MPC-160: No decedent contact found');

  const hasWill            = !!toggleAnswers.hasWill;
  const renunciation       = !!toggleAnswers.renunciation;
  const suretyWaived       = !!toggleAnswers.suretyWaived;
  const willWaivesSureties = !!toggleAnswers.willWaivesSureties;
  const bondWithSureties   = !!toggleAnswers.bondWithSureties;
  const supervisedRequired = !!toggleAnswers.supervisedRequired;
  const bondAmount         = toggleAnswers.bondAmount || '';
  const willDate           = toggleAnswers.willDate   || '';
  const codicilDates       = toggleAnswers.codicilDates || '';
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const ageAtDeath = calculateAgeAtDeath(dec?.date_of_birth, dec?.date_of_death);

  const petRelArray = toggleAnswers.petitionerRelationships;
  const petInterest = (Array.isArray(petRelArray) && petRelArray.length > 0)
    ? petRelArray.join(', ')
    : 'Personal Representative';

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const repName = rep ? `${rep.first_name || ''} ${rep.last_name || ''}`.trim() : '';

  const d = {
    docketNo:   matter.docket_no || '',
    division,
    isAmended:  !!toggleAnswers.isAmended,
    // decedent header
    decLn:      dec?.last_name  || '',
    decFn:      dec?.first_name || '',
    decMn:      safeMI(dec),
    dod:        formatDate(dec?.date_of_death),
    // Q1 decedent
    decAge:     ageAtDeath !== null ? String(ageAtDeath) : '',
    decDomCity: decAddr?.city  || '',
    decDomState:decAddr?.state || '',
    decStreet:  decAddr?.street      || '',
    decCity:    decAddr?.city        || '',
    decState:   decAddr?.state       || '',
    decZip:     decAddr?.postal_code || '',
    // Q2 petitioner
    repLn:      rep?.last_name  || '',
    repFn:      rep?.first_name || '',
    repMi:      safeMI(rep),
    repStreet:  repAddr?.street      || '',
    repCity:    repAddr?.city        || '',
    repState:   repAddr?.state       || '',
    repZip:     repAddr?.postal_code || '',
    repPhone:   phone(rep),
    repEmail:   email(rep),
    petInterest,
    // will
    hasWill, willDate, codicilDates,
    // bond
    bondAmount, suretyWaived, willWaivesSureties, bondWithSureties,
    // priority / admin type
    renunciation, supervisedRequired,
    // prior informal proceeding
    priorInformalProceeding:   !!toggleAnswers.priorInformalProceeding,
    priorInformalDocketNumber: toggleAnswers.priorInformalDocketNumber || '',
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
    // Quiet set: assigns checkbox without dispatching events, bypassing form JS cascades
    function setQ(name, val) {
      const el = document.querySelector('[name="' + name + '"]');
      if (el) el.checked = !!val;
    }

    // Header
    set('DocketNo_6',              d.docketNo);
    set('EstateOf_LnName_10',      d.decLn);
    set('EstateOf_FnName_11',      d.decFn);
    set('EstateOf_MN_12',          d.decMn);
    set('EstateOf_DateOfDeath_13', d.dod);
    set('Division_19',             d.division);
    setQ('AmendedForm_21',         !!d.isAmended);
    setQ('OriginalForm_22',        !d.isAmended);

    // Petition type — quiet-set prevents cascade between mutually exclusive checkboxes
    setQ('ProbateOfWill_7',            !!d.hasWill);
    setQ('AdjudicationOfIntestacy_8',  !d.hasWill);
    set('AppointmentOfPersonalRep_14', true);

    // Q1 – decedent details
    set('Q1_LnName_24',                  d.decLn);
    set('Q1_FnName_26',                  d.decFn);
    set('Q1_MN_25',                      d.decMn);
    set('Q1__AgeOfDeath_33',             d.decAge);
    set('Q1_DomiciledInCityTown_44',     d.decDomCity);
    set('Q1_DomiciledInState_45',        d.decDomState);
    set('Q1_Address_51',                 d.decStreet);
    set('Q1_CityTown_49',                d.decCity);
    set('Q1_State_48',                   d.decState);
    set('Q1_Zip_47',                     d.decZip);
    set('Q1_DeathCertificateWithCourtPetition_55', true);

    // Q2 – petitioner
    set('Q2_LnName_63',             d.repLn);
    set('Q2_FnName_65',             d.repFn);
    set('Q2_MI_66',                 d.repMi);
    set('Q2_Address_67',            d.repStreet);
    set('Q2_CityTown_68',           d.repCity);
    set('Q2_State_69',              d.repState);
    set('Q2_Zip_70',                d.repZip);
    set('Q2_PrimaryPhone_79',       d.repPhone);
    set('Q2_Email_83',              d.repEmail);
    set('Q2_PetInterestInState_80', d.petInterest);

    // Q4 – venue
    set('Q4_DomiciledinCounty_99', true);

    // Q5 – DMA notice
    set('Q5_PetitionerShallGiveNotice_108', true);

    // Q7 – will / intestate — quiet-set prevents cascade
    setQ('Q7_IntestateWithoutWill_120', !d.hasWill);
    setQ('Q7_TestateWithWill_129',       d.hasWill);
    set('Q7_DecedentLastWillDate_127',   d.willDate);
    set('TextField6_128',                d.codicilDates);
    set('Q7_OriginalWillInCourtPet_133', d.hasWill);

    // Q8 – personal representative
    set('Q8_PetRequestApptOfPersonalRep_148', true);
    set('Q8_SelfOnly_151',    true);
    set('Q8_LnName_155',      d.repLn);
    set('Q8_MI_156',          d.repMi);
    set('Q8_FnName_157',      d.repFn);
    set('Q8_Address_162',     d.repStreet);
    set('Q8_CityTown_160',    d.repCity);
    set('Q8_State_159',       d.repState);
    set('Q8_Zip_158',         d.repZip);
    set('Q8_PrimaryPhone_170',d.repPhone);
    set('Q8_Email_172',       d.repEmail);

    // Q9 – priority
    setQ('Q9_ByStatue_181',               !d.renunciation);
    setQ('Q9_ByRenunciationNomination_180', d.renunciation);

    // Q10 – no GAL
    set('Q10_NoCourtAppPetRep_209', true);

    // Q11 – bond
    setQ('Q11_BondWithOutSureties_227',          !d.bondWithSureties);
    setQ('Q11_BondWithSureties_228',             !!d.bondWithSureties);
    set('Q11_BondWithSuretiesSum_231',            d.bondAmount);
    set('Q11_AllDeviseesHeirsWaivedSureties_232', d.suretyWaived);
    set('Q11_WillWaivesSureties_233',             d.willWaivesSureties);

    // Q12 – administration type (parent + sub-reason)
    setQ('Q12_UnsupervisedAdmin_239', !d.supervisedRequired);
    setQ('Q12_SupervisedAdmin_247',   !!d.supervisedRequired);
    if (!d.supervisedRequired) {
      // Sub-reason for unsupervised
      setQ('Q12_WillDirectsUnsupervisedAdmin_243', !!d.hasWill);
      setQ('Q12_DecedentDiedWithoutWill_244',       !d.hasWill);
    } else {
      // Sub-reason for supervised
      setQ('Q12_DirectsSupervisedAdmin_249',      !!d.hasWill);
      setQ('Q12_NoWillDirectsSupervisedAdmin_253', !d.hasWill);
    }

    // Q13 – relief requested
    setQ('Q13_AdmingWillToProbate_263',        !!d.hasWill);
    setQ('Q13_DetDecedentDiedWithoutWill_264',  !d.hasWill);
    set('Q13_ApptNomineesAsPetRep_265',         true);
    setQ('Q13_Unsupervised_266',               !d.supervisedRequired);
    setQ('Q13_SupervisedAdmin_267',            !!d.supervisedRequired);
    setQ('Q13_Without_269',                    !d.bondWithSureties);
    setQ('Q13_With_270',                       !!d.bondWithSureties);
    set('Q13_DetHeirsOfDecedent_271',           true);
    if (d.priorInformalProceeding) {
      set('Q13_PriorInformalFindings_275',    true);
      set('Q13_PrioirInformalApptPetRep_276', true);
      set('LG1_279',                          d.priorInformalDocketNumber);
    }

    // Signature block
    set('DateByPetitioner_286',     d.sigDate);
    set('SignatureByPetitioner_289', d.repName);

    // Attorney block
    set('AttorneyPrintName_291',    d.firm.name);
    set('BBO_292',                  d.firm.bbo);
    set('AttorneyPrimaryPhone_293', d.firm.phone);
    set('AttorneyAddress_297',      d.firm.street);
    set('AttorneyCityTown_296',     d.firm.city);
    set('AttorneyState_295',        d.firm.state);
    set('AttorneyZip_294',          d.firm.zip);
    set('AttorneyEmail_302',        d.firm.email);
  }, d);

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC160 };
