'use strict';
const puppeteer = require('puppeteer');
const { addr, phone, email, formatDate, identifyContacts, fullAddr, getMatterCaption, NON_HEIR_TYPES, FIRM_PROFILE, getCountyFromAddress, MA_COUNTY_TO_DIVISION } = require('./common');
const { generateContinuationPages, mergeWithContinuation } = require('./maContinuationPage');

const COURT_URL = 'https://courtforms.jud.state.ma.us/publicforms/PFC0020';

const NOTICE_SLOTS = 4;

async function fillMPC550(matter, contacts, assets, toggleAnswers = {}) {
  const { decedent: dec, representative: rep } = identifyContacts(
    contacts, matter.contact_main, matter.contact_representative
  );
  const warnings = [];
  if (!dec) warnings.push('MPC-550: No decedent contact found');
  if (!rep)  warnings.push('MPC-550: No representative contact found');

  const repAddr = addr(rep);
  const decAddr = addr(dec);

  // Division: same auto-detect as MPC-150 (county from decedent address or maCounty toggle)
  const autoCounty    = getCountyFromAddress(decAddr, 'MA');
  const resolvedCounty = autoCounty || toggleAnswers.maCounty || null;
  const division = resolvedCounty
    ? (MA_COUNTY_TO_DIVISION[resolvedCounty] || resolvedCounty)
    : (toggleAnswers.division || '');

  // Build sets for waiver filtering from mpc455Config
  const mpc455Config = toggleAnswers.mpc455Config || [];
  const waivedIds   = new Set(mpc455Config.filter(p => p.waiverOfNotice).map(p => p.id));
  const waivedParties = contacts.filter(c => waivedIds.has(c.id));

  // Notice parties: exclude non-heir types, the representative, and anyone who waived notice
  const allNoticeParties = contacts
    .filter(c => !NON_HEIR_TYPES.has(c.relationship?.type) && c.id !== rep?.id && !waivedIds.has(c.id))
    .map(c => ({
      name:    c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' '),
      address: fullAddr(addr(c)),
      rel:     c.relationship?.short || '',
    }));

  const noticeParties   = allNoticeParties.slice(0, NOTICE_SLOTS);
  const overflowParties = allNoticeParties.slice(NOTICE_SLOTS);

  if (overflowParties.length > 0) {
    warnings.push(
      `MPC-550: ${allNoticeParties.length} notice parties — first ${NOTICE_SLOTS} on court form, ` +
      `${overflowParties.length} on continuation sheet.`
    );
  }

  const waivedNames = waivedParties.map(c => c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' '));
  if (waivedNames.length > 6) {
    warnings.push(`MPC-550: ${waivedNames.length} parties waived notice — only 6 name slots on form; attach MPC-455 waivers for all.`);
  } else if (waivedNames.length > 0) {
    warnings.push(`MPC-550: ${waivedNames.length} party(ies) waived notice — MPC-455 waivers must be attached.`);
  }

  const today     = new Date();
  const sigDate   = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const noticeDate = toggleAnswers.noticeDate || sigDate;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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
    set('Fn_7',             d.dec?.first_name);
    set('Ln_8',             d.dec?.last_name);
    set('Mn_9',             d.dec?.middle_name);
    set('TextField4_12',    '');           // AKA — blank
    set('DateTimeField3_13', d.dod);
    set('Division_15',       d.division);

    // Page 2 "Estate of" header (XFA-named fields — separate from page 1 header)
    set('Fnxfa[0].form[0].form1[0].pageSet[0]Page2_ID_8',        d.dec?.first_name);
    set('Mnxfa[0].form[0].form1[0].pageSet[0]Page2_ID_9',        d.dec?.middle_name);
    set('Lnxfa[0].form[0].form1[0].pageSet[0]Page2_ID_7',        d.dec?.last_name);
    set('DocketNoxfa[0].form[0].form1[0].pageSet[0]Page2_ID_10', d.docketNo);

    // Notice date
    set('DateTimeField1_18', d.noticeDate);

    // PR info (primary)
    set('FN_21',       d.rep?.first_name);
    set('MI_22',       d.rep?.middle_name);
    set('LN_23',       d.rep?.last_name);
    set('cityTown_24', d.repAddr?.city);
    set('State_25',    d.repAddr?.state);

    // Will / appointment
    set('Will_33', d.toggles.hasWill);
    set('appt_35', true);

    // Testate/intestate radio
    const radios = document.querySelectorAll('[name="RadioButtonList_36"]');
    if (radios.length >= 2) {
      radios[0].checked = !!d.toggles.hasWill;
      radios[1].checked = !d.toggles.hasWill;
    }

    // PR info copy
    set('FN_40',       d.rep?.first_name);
    set('MI_41',       d.rep?.middle_name);
    set('LN_42',       d.rep?.last_name);
    set('cityTown_43', d.repAddr?.city);
    set('State_44',    d.repAddr?.state);

    // "I, [attorney], hereby certify..." certification line (probe-confirmed: TextField4_55)
    set('TextField4_55', d.firm.fullName);

    // Notice rows (up to 4)
    // Probe-confirmed field IDs: row name=58/67/76/85, addr=62/71/80/89
    // (Previous mapping used 55/71/80/89 for names — 55 is the certifier field, not a row name)
    const rowFields = [
      { name: 'TextField4_58',  mail: 'CheckBox1_60',  deliver: 'CheckBox1_61',  addr: 'TextField4_62',  date: 'DateTimeField1_64' },
      { name: 'TextField4_67',  mail: 'CheckBox1_69',  deliver: 'CheckBox1_70',  addr: 'TextField4_71',  date: 'DateTimeField1_73' },
      { name: 'TextField4_76',  mail: 'CheckBox1_78',  deliver: 'CheckBox1_79',  addr: 'TextField4_80',  date: 'DateTimeField1_82' },
      { name: 'TextField4_85',  mail: 'CheckBox1_87',  deliver: 'CheckBox1_88',  addr: 'TextField4_89',  date: 'DateTimeField1_91' },
    ];

    d.noticeParties.slice(0, 4).forEach((p, i) => {
      const f = rowFields[i];
      set(f.name,    p.name);
      set(f.mail,    true);
      if (f.deliver) set(f.deliver, false);
      set(f.addr,    p.address);
      set(f.date,    d.noticeDate);
    });

    // Waiver of notice — checkbox + up to 6 name slots (probe-confirmed: 99–104)
    set('CheckBox1_97', d.waivedNames.length > 0);
    const waiverSlots = ['TextField4_99','TextField4_100','TextField4_101','TextField4_102','TextField4_103','TextField4_104'];
    d.waivedNames.slice(0, 6).forEach((name, i) => set(waiverSlots[i], name));

    // Attorney/counsel signature block — LEFT only (probe-confirmed layout):
    // 130=sig name, 110=address, 111=apt, 112=city, 113=state, 114=zip, 115=phone, 126=BBO#
    set('TextField6_130',  d.firm.fullName);
    set('TextField4_110',  d.firm.street);
    set('TextField4_111',  '');
    set('TextField4_112',  d.firm.city);
    set('TextField4_113',  d.firm.state);
    set('TextField5_114',  d.firm.zip);
    set('TextField4_115',  d.firm.phone);
    set('TextField4_126',  d.firm.bbo);
    // RIGHT block = petitioner — left blank for wet signature

    // Certification date
    set('DateTimeField3_127', d.sigDate);
  }, {
    docketNo:     matter.docket_no || '',
    division,
    dod:          formatDate(dec?.date_of_death || ''),
    sigDate,
    noticeDate,
    toggles:      toggleAnswers,
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
    repEmail: email(rep),
    noticeParties,
    waivedNames,
    firm: {
      fullName:  FIRM_PROFILE.attorneyNameFull,
      firstName: FIRM_PROFILE.attorneyName.split(' ')[0],
      lastName:  FIRM_PROFILE.attorneyName.split(' ').slice(1).join(' '),
      street:    FIRM_PROFILE.address,
      city:      FIRM_PROFILE.city,
      state:     FIRM_PROFILE.state,
      zip:       FIRM_PROFILE.zip,
      phone:     FIRM_PROFILE.phone,
      email:     FIRM_PROFILE.email,
      bbo:       FIRM_PROFILE.bbo,
    },
  });

  const mainBytes = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();

  // ── Continuation pages for overflow notice parties ─────────────────────────
  let finalBytes = mainBytes;
  if (overflowParties.length > 0) {
    const caption  = getMatterCaption(matter, contacts, division);
    const contBytes = await generateContinuationPages({
      formId:              '550',
      formTitle:           'Notice',
      decedentName:        caption.decedentName,
      docketNumber:        caption.docketNumber,
      county:              caption.county,
      columns: [
        { header: 'Name',             key: 'name',    width: '30%' },
        { header: 'Address',          key: 'address', width: '38%' },
        { header: 'Method of Notice', key: 'method',  width: '17%' },
        { header: 'Date of Notice',   key: 'date',    width: '15%' },
      ],
      entries: overflowParties.map(p => ({ ...p, method: 'Mail', date: noticeDate })),
      startingEntryNumber: NOTICE_SLOTS + 1,
      pageNumberOffset:    2,
    });
    finalBytes = await mergeWithContinuation(mainBytes, contBytes);
  }

  return { bytes: finalBytes, warnings };
}

module.exports = { fillMPC550 };
