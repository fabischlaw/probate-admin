'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, formatDate, identifyContacts, getMatterCaption, NON_HEIR_TYPES, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0012';

// Build a single-person data object from a personConfig + contacts lookup.
// personConfig is one entry from mpc455Config (produced by computePRPriority).
function buildPartyFromConfig(personConfig, contacts) {
  const contact = contacts.find(c => c.id === personConfig.id);
  if (!contact) return null;
  return {
    first_name:  contact.first_name  || '',
    last_name:   contact.last_name   || '',
    middle_name: contact.middle_name || '',
    addr:        addr(contact),
    phoneNum:    phone(contact),
    capacityLabel: personConfig.capacityLabel || '',
  };
}

async function fillMPC455(matter, contacts, assets, toggleAnswers = {}, personConfig = null) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-455: No decedent contact found');

  // Resolve the signing party
  let party;
  if (personConfig) {
    party = buildPartyFromConfig(personConfig, contacts);
    if (!party) warnings.push(`MPC-455: Contact not found for id ${personConfig.id}`);
  } else {
    // Legacy path: use the representative
    party = rep ? {
      first_name:  rep.first_name,
      last_name:   rep.last_name,
      middle_name: rep.middle_name,
      addr:        addr(rep),
      phoneNum:    phone(rep),
      capacityLabel: rep.relationship?.short || '',
    } : null;
    if (!party) warnings.push('MPC-455: No party contact found for signature');
  }

  const decAddr = addr(dec);
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  const today   = new Date();
  const sigDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  const decName = dec ? `${dec.first_name || ''} ${dec.last_name || ''}`.trim() : '';
  const dod     = formatDate(dec?.date_of_death || '');

  // Action flags — from personConfig when provided, else from legacy toggleAnswers
  const flags = personConfig ? {
    assent:              !!personConfig.assent,
    waiverOfNotice:      !!personConfig.waiverOfNotice,
    renunciation:        !!personConfig.renunciation,
    nomination:          !!personConfig.nomination,
    consentToNomination: !!personConfig.consentToNomination,
    waiverOfSureties:    !!personConfig.waiverOfSureties,
  } : {
    assent:              !!toggleAnswers.assentPetition,
    waiverOfNotice:      !!toggleAnswers.waiverNotice,
    renunciation:        !!toggleAnswers.renounceAppointment,
    nomination:          !!toggleAnswers.nominatePR,
    consentToNomination: !!toggleAnswers.consentToAppointment,
    waiverOfSureties:    !!toggleAnswers.waiverSureties || !!toggleAnswers.waiverOfBond,
  };

  // Nominee name for renunciation (Section II B) — who the person nominates to serve in their place
  // Per probe: TextField4_32 = Last Name, TextField4_33 = M.I., TextField4_34 = First Name
  const renomineeName = personConfig?.nomineeName || {
    first: toggleAnswers.nomineeFirst || '',
    last:  toggleAnswers.nomineeLast  || '',
    mi:    toggleAnswers.nomineeMI    || '',
  };

  // Nominee name for consent (Section II C) — who the person is consenting to serve
  // Per probe: TextField4_43 = First Name, TextField4_44 = Last Name, TextField4_45 = M.I.
  const consenteeName = personConfig?.nomineeForConsent || renomineeName;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.goto(COURT_URL, { waitUntil: 'networkidle0' });
  try { await page.waitForSelector('[name="DocketNo_8"]', { timeout: 10000 }); } catch (_) {}
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
    set('DocketNo_8',       d.docketNo);
    set('TextField4_11',    d.decName);
    set('DropDownList1_12', d.division);
    set('TextField4_16',    d.petitionDesc);

    // Section I — Assent and Waiver of Notice
    set('CheckBox1_4',  d.flags.assent);
    set('CheckBox1_21', d.flags.waiverOfNotice);

    // Section II — Renunciation / Nomination
    // (A) renounce without nominating
    set('CheckBox1_6', d.flags.renunciation && !d.flags.nomination);
    // (B) renounce and nominate (TextField4_32=Last, _33=MI, _34=First)
    set('CheckBox1_9', d.flags.renunciation && d.flags.nomination);
    if (d.flags.renunciation && d.flags.nomination) {
      set('TextField4_32', d.renomineeName.last);
      set('TextField4_33', d.renomineeName.mi);
      set('TextField4_34', d.renomineeName.first);
    }
    // (C) consent to another's nomination (TextField4_43=First, _44=Last, _45=MI)
    set('CheckBox1_22', d.flags.consentToNomination);
    if (d.flags.consentToNomination) {
      set('TextField4_43', d.consenteeName.first);
      set('TextField4_44', d.consenteeName.last);
      set('TextField4_45', d.consenteeName.mi);
    }

    // Heir/devisee capacity checkboxes — set by default
    set('CheckBox1_39', true);
    set('CheckBox1_52', !!d.party?.capacityLabel);

    // Section III — Waiver of Sureties
    set('CheckBox1_5',  d.flags.waiverOfSureties); // section header checkbox
    set('CheckBox1_26', d.flags.waiverOfSureties); // section body checkbox

    // Signature block — signer's own name and address
    set('DateTimeField3_61', d.sigDate);
    set('TextField5_62',     d.party?.last_name);
    set('TextField5_63',     d.party?.first_name);
    set('TextField5_64',     d.party?.middle_name);
    set('TextField5_65',     d.party?.addr?.street);
    set('TextField4_66',     d.party?.addr?.city);
    set('Phone_67',          d.party?.phoneNum);
    set('TextField6_68',     d.party?.addr?.state);
    set('TextField5_69',     d.party?.addr?.postal_code);
  }, {
    docketNo:    matter.docket_no || '',
    decName,
    dod,
    division:    division,
    petitionDesc: toggleAnswers.hasWill
      ? 'Petition for Informal Probate of Will and Appointment of Personal Representative'
      : 'Petition for Informal Appointment of Personal Representative',
    flags,
    renomineeName,
    consenteeName,
    sigDate,
    party: party ? {
      first_name:    party.first_name,
      last_name:     party.last_name,
      middle_name:   party.middle_name || '',
      capacityLabel: party.capacityLabel || '',
      addr:          party.addr || {},
      phoneNum:      party.phoneNum || '',
    } : null,
  });

  const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return { bytes: pdfBytes, warnings };
}

module.exports = { fillMPC455 };
