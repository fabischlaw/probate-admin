const { rgb } = require('pdf-lib');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..');

// TODO: Replace with user profile system when app is multi-user.
// FIRM_PROFILE will become a per-user lookup.
const FIRM_PROFILE = {
  attorneyName:     'Matthew Fabisch',
  attorneyNameFull: 'Matthew Fabisch, Esq.',
  bbo:              '673821',
  email:            'Fabisch@Fabischlaw.com',
  phone:            '401-324-9344',
  firmName:         'Fabisch Law Offices',
  address:          '26 Gladstone St.',
  city:             'Smithfield',
  state:            'RI',
  zip:              '02917',
};

// Legacy alias — form fillers import { FIRM } and use FIRM.name, FIRM.street, etc.
const FIRM = {
  name:   FIRM_PROFILE.attorneyNameFull,
  firm:   FIRM_PROFILE.firmName,
  full:   `${FIRM_PROFILE.attorneyNameFull}, ${FIRM_PROFILE.firmName}`,
  street: FIRM_PROFILE.address,
  city:   FIRM_PROFILE.city,
  state:  FIRM_PROFILE.state,
  zip:    FIRM_PROFILE.zip,
  email:  FIRM_PROFILE.email,
  phone:  FIRM_PROFILE.phone,
  bbo:    FIRM_PROFILE.bbo,
};

const RESIDENT_AGENT = {
  name:   FIRM_PROFILE.attorneyNameFull,
  street: FIRM_PROFILE.address,
  city:   FIRM_PROFILE.city,
  state:  FIRM_PROFILE.state,
  zip:    FIRM_PROFILE.zip,
  email:  FIRM_PROFILE.email,
  phone:  FIRM_PROFILE.phone,
};

// Contacts that are never heirs/interested parties: client, decedent, divorced spouse,
// and all professional/advisor relationship types
const NON_HEIR_TYPES = new Set([
  '0CLNT', '1MAIN', '1DIVO',
  '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
  '4CONT',
]);
const SPOUSE_TYPES   = new Set(['1MARR', '1WIDW', '3LIFP']);

const RI_CITY_TO_COUNTY = {
  barrington: 'Bristol', bristol: 'Bristol', warren: 'Bristol',
  burrillville: 'Providence', 'central falls': 'Providence', cranston: 'Providence',
  cumberland: 'Providence', 'east providence': 'Providence', foster: 'Providence',
  glocester: 'Providence', johnston: 'Providence', lincoln: 'Providence',
  'north providence': 'Providence', 'north smithfield': 'Providence',
  pawtucket: 'Providence', providence: 'Providence', scituate: 'Providence',
  smithfield: 'Providence', woonsocket: 'Providence',
  coventry: 'Kent', 'east greenwich': 'Kent', warwick: 'Kent',
  'west greenwich': 'Kent', 'west warwick': 'Kent',
  charlestown: 'Washington', exeter: 'Washington', hopkinton: 'Washington',
  jamestown: 'Washington', narragansett: 'Washington', 'new shoreham': 'Washington',
  'north kingstown': 'Washington', richmond: 'Washington',
  'south kingstown': 'Washington', westerly: 'Washington',
  'little compton': 'Newport', middletown: 'Newport', newport: 'Newport',
  portsmouth: 'Newport', tiverton: 'Newport',
};

// All 351 MA municipalities → county (Probate and Family Court divisions)
const MA_CITY_TO_COUNTY = {
  // Barnstable County
  barnstable: 'Barnstable', bourne: 'Barnstable', brewster: 'Barnstable',
  chatham: 'Barnstable', dennis: 'Barnstable', eastham: 'Barnstable',
  falmouth: 'Barnstable', harwich: 'Barnstable', mashpee: 'Barnstable',
  orleans: 'Barnstable', provincetown: 'Barnstable', sandwich: 'Barnstable',
  truro: 'Barnstable', wellfleet: 'Barnstable', yarmouth: 'Barnstable',
  // Berkshire County
  adams: 'Berkshire', alford: 'Berkshire', becket: 'Berkshire',
  cheshire: 'Berkshire', clarksburg: 'Berkshire', dalton: 'Berkshire',
  egremont: 'Berkshire', florida: 'Berkshire', 'great barrington': 'Berkshire',
  hancock: 'Berkshire', hinsdale: 'Berkshire', lanesborough: 'Berkshire',
  lee: 'Berkshire', lenox: 'Berkshire', monterey: 'Berkshire',
  'mount washington': 'Berkshire', 'new ashford': 'Berkshire',
  'new marlborough': 'Berkshire', 'north adams': 'Berkshire', otis: 'Berkshire',
  peru: 'Berkshire', pittsfield: 'Berkshire', richmond: 'Berkshire',
  sandisfield: 'Berkshire', savoy: 'Berkshire', sheffield: 'Berkshire',
  stockbridge: 'Berkshire', tyringham: 'Berkshire', washington: 'Berkshire',
  'west stockbridge': 'Berkshire', williamstown: 'Berkshire', windsor: 'Berkshire',
  // Bristol County
  acushnet: 'Bristol', attleboro: 'Bristol', berkley: 'Bristol',
  dartmouth: 'Bristol', dighton: 'Bristol', easton: 'Bristol',
  fairhaven: 'Bristol', 'fall river': 'Bristol', freetown: 'Bristol',
  mansfield: 'Bristol', 'new bedford': 'Bristol', 'north attleborough': 'Bristol',
  'north attleboro': 'Bristol', norton: 'Bristol', raynham: 'Bristol',
  rehoboth: 'Bristol', seekonk: 'Bristol', somerset: 'Bristol',
  swansea: 'Bristol', taunton: 'Bristol', westport: 'Bristol',
  // Dukes County (Martha's Vineyard)
  aquinnah: 'Dukes', chilmark: 'Dukes', edgartown: 'Dukes',
  gosnold: 'Dukes', 'oak bluffs': 'Dukes', tisbury: 'Dukes',
  'west tisbury': 'Dukes',
  // Essex County
  amesbury: 'Essex', andover: 'Essex', beverly: 'Essex',
  boxford: 'Essex', danvers: 'Essex', essex: 'Essex',
  georgetown: 'Essex', gloucester: 'Essex', groveland: 'Essex',
  hamilton: 'Essex', haverhill: 'Essex', ipswich: 'Essex',
  lawrence: 'Essex', lynn: 'Essex', lynnfield: 'Essex',
  'manchester-by-the-sea': 'Essex', manchester: 'Essex',
  marblehead: 'Essex', merrimac: 'Essex', methuen: 'Essex',
  middleton: 'Essex', nahant: 'Essex', newbury: 'Essex',
  newburyport: 'Essex', 'north andover': 'Essex', peabody: 'Essex',
  rockport: 'Essex', rowley: 'Essex', salem: 'Essex',
  salisbury: 'Essex', saugus: 'Essex', swampscott: 'Essex',
  topsfield: 'Essex', wenham: 'Essex', 'west newbury': 'Essex',
  // Franklin County
  ashfield: 'Franklin', bernardston: 'Franklin', buckland: 'Franklin',
  charlemont: 'Franklin', colrain: 'Franklin', conway: 'Franklin',
  deerfield: 'Franklin', erving: 'Franklin', gill: 'Franklin',
  greenfield: 'Franklin', hawley: 'Franklin', heath: 'Franklin',
  leverett: 'Franklin', leyden: 'Franklin', monroe: 'Franklin',
  montague: 'Franklin', 'new salem': 'Franklin', northfield: 'Franklin',
  orange: 'Franklin', rowe: 'Franklin', shelburne: 'Franklin',
  shutesbury: 'Franklin', sunderland: 'Franklin', warwick: 'Franklin',
  wendell: 'Franklin', whately: 'Franklin',
  // Hampden County
  agawam: 'Hampden', blandford: 'Hampden', brimfield: 'Hampden',
  chester: 'Hampden', chicopee: 'Hampden', 'east longmeadow': 'Hampden',
  granville: 'Hampden', hampden: 'Hampden', holland: 'Hampden',
  holyoke: 'Hampden', longmeadow: 'Hampden', ludlow: 'Hampden',
  monson: 'Hampden', montgomery: 'Hampden', palmer: 'Hampden',
  russell: 'Hampden', southwick: 'Hampden', springfield: 'Hampden',
  tolland: 'Hampden', wales: 'Hampden', 'west springfield': 'Hampden',
  westfield: 'Hampden', wilbraham: 'Hampden',
  // Hampshire County
  amherst: 'Hampshire', belchertown: 'Hampshire', chesterfield: 'Hampshire',
  cummington: 'Hampshire', easthampton: 'Hampshire', goshen: 'Hampshire',
  granby: 'Hampshire', hadley: 'Hampshire', hatfield: 'Hampshire',
  huntington: 'Hampshire', middlefield: 'Hampshire', northampton: 'Hampshire',
  pelham: 'Hampshire', plainfield: 'Hampshire', southampton: 'Hampshire',
  'south hadley': 'Hampshire', ware: 'Hampshire', westhampton: 'Hampshire',
  williamsburg: 'Hampshire', worthington: 'Hampshire',
  // Middlesex County
  acton: 'Middlesex', arlington: 'Middlesex', ashby: 'Middlesex',
  ashland: 'Middlesex', ayer: 'Middlesex', bedford: 'Middlesex',
  belmont: 'Middlesex', billerica: 'Middlesex', boxborough: 'Middlesex',
  burlington: 'Middlesex', cambridge: 'Middlesex', carlisle: 'Middlesex',
  chelmsford: 'Middlesex', concord: 'Middlesex', dracut: 'Middlesex',
  dunstable: 'Middlesex', everett: 'Middlesex', framingham: 'Middlesex',
  groton: 'Middlesex', holliston: 'Middlesex', hopkinton: 'Middlesex',
  hudson: 'Middlesex', lexington: 'Middlesex', lincoln: 'Middlesex',
  littleton: 'Middlesex', lowell: 'Middlesex', malden: 'Middlesex',
  marlborough: 'Middlesex', maynard: 'Middlesex', medford: 'Middlesex',
  melrose: 'Middlesex', natick: 'Middlesex', newton: 'Middlesex',
  'north reading': 'Middlesex', pepperell: 'Middlesex', reading: 'Middlesex',
  sherborn: 'Middlesex', shirley: 'Middlesex', somerville: 'Middlesex',
  stow: 'Middlesex', sudbury: 'Middlesex', tewksbury: 'Middlesex',
  townsend: 'Middlesex', tyngsborough: 'Middlesex', wakefield: 'Middlesex',
  waltham: 'Middlesex', watertown: 'Middlesex', wayland: 'Middlesex',
  westford: 'Middlesex', weston: 'Middlesex', wilmington: 'Middlesex',
  winchester: 'Middlesex', woburn: 'Middlesex',
  // Nantucket County
  nantucket: 'Nantucket',
  // Norfolk County
  avon: 'Norfolk', bellingham: 'Norfolk', braintree: 'Norfolk',
  brookline: 'Norfolk', canton: 'Norfolk', cohasset: 'Norfolk',
  dedham: 'Norfolk', dover: 'Norfolk', foxborough: 'Norfolk',
  foxboro: 'Norfolk', franklin: 'Norfolk', holbrook: 'Norfolk',
  medfield: 'Norfolk', medway: 'Norfolk', millis: 'Norfolk',
  milton: 'Norfolk', needham: 'Norfolk', norfolk: 'Norfolk',
  norwood: 'Norfolk', plainville: 'Norfolk', quincy: 'Norfolk',
  randolph: 'Norfolk', sharon: 'Norfolk', stoughton: 'Norfolk',
  walpole: 'Norfolk', wellesley: 'Norfolk', westwood: 'Norfolk',
  weymouth: 'Norfolk', wrentham: 'Norfolk',
  // Plymouth County
  abington: 'Plymouth', bridgewater: 'Plymouth', brockton: 'Plymouth',
  carver: 'Plymouth', duxbury: 'Plymouth', 'east bridgewater': 'Plymouth',
  halifax: 'Plymouth', hanover: 'Plymouth', hanson: 'Plymouth',
  hingham: 'Plymouth', hull: 'Plymouth', kingston: 'Plymouth',
  lakeville: 'Plymouth', marion: 'Plymouth', marshfield: 'Plymouth',
  mattapoisett: 'Plymouth', middleborough: 'Plymouth', middleboro: 'Plymouth',
  norwell: 'Plymouth', pembroke: 'Plymouth', plymouth: 'Plymouth',
  plympton: 'Plymouth', rochester: 'Plymouth', rockland: 'Plymouth',
  scituate: 'Plymouth', wareham: 'Plymouth', 'west bridgewater': 'Plymouth',
  whitman: 'Plymouth',
  // Suffolk County
  boston: 'Suffolk', chelsea: 'Suffolk', revere: 'Suffolk', winthrop: 'Suffolk',
  // Worcester County
  ashburnham: 'Worcester', athol: 'Worcester', auburn: 'Worcester',
  barre: 'Worcester', berlin: 'Worcester', blackstone: 'Worcester',
  bolton: 'Worcester', boylston: 'Worcester', brookfield: 'Worcester',
  charlton: 'Worcester', clinton: 'Worcester', douglas: 'Worcester',
  dudley: 'Worcester', 'east brookfield': 'Worcester', fitchburg: 'Worcester',
  gardner: 'Worcester', grafton: 'Worcester', hardwick: 'Worcester',
  harvard: 'Worcester', holden: 'Worcester', hopedale: 'Worcester',
  hubbardston: 'Worcester', lancaster: 'Worcester', leicester: 'Worcester',
  leominster: 'Worcester', lunenburg: 'Worcester', mendon: 'Worcester',
  milford: 'Worcester', millbury: 'Worcester', millville: 'Worcester',
  'new braintree': 'Worcester', 'north brookfield': 'Worcester',
  northborough: 'Worcester', northbridge: 'Worcester', oakham: 'Worcester',
  oxford: 'Worcester', paxton: 'Worcester', petersham: 'Worcester',
  phillipston: 'Worcester', princeton: 'Worcester', royalston: 'Worcester',
  rutland: 'Worcester', shrewsbury: 'Worcester', southborough: 'Worcester',
  southbridge: 'Worcester', spencer: 'Worcester', sterling: 'Worcester',
  sturbridge: 'Worcester', sutton: 'Worcester', templeton: 'Worcester',
  upton: 'Worcester', uxbridge: 'Worcester', warren: 'Worcester',
  webster: 'Worcester', westborough: 'Worcester', 'west boylston': 'Worcester',
  'west brookfield': 'Worcester', winchendon: 'Worcester', worcester: 'Worcester',
};

// Probate & Family Court division name for each MA county
const MA_COUNTY_TO_DIVISION = {
  Barnstable: 'Barnstable',  Berkshire:  'Berkshire',  Bristol:    'Bristol',
  Dukes:      'Dukes County', Essex:      'Essex',       Franklin:   'Franklin',
  Hampden:    'Hampden',     Hampshire:  'Hampshire',   Middlesex:  'Middlesex',
  Nantucket:  'Nantucket',   Norfolk:    'Norfolk',     Plymouth:   'Plymouth',
  Suffolk:    'Suffolk',     Worcester:  'Worcester',
};

// Given a contact address object and optional state hint, return the MA county name or null.
// addrObj is expected to have { city, state } fields.
function getCountyFromAddress(addrObj, stateHint) {
  if (!addrObj || typeof addrObj !== 'object') return null;
  const s = (addrObj.state || stateHint || '').trim().toUpperCase();
  if (s !== 'MA' && s !== 'MASSACHUSETTS') return null;
  const city = (addrObj.city || '').trim().toLowerCase();
  return MA_CITY_TO_COUNTY[city] || null;
}

function cityToCounty(city) {
  return city ? (RI_CITY_TO_COUNTY[city.toLowerCase().trim()] ?? null) : null;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  // Already MM/DD/YYYY — return as-is (e.g. willDate from toggleAnswers)
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
  // ISO YYYY-MM-DD from DecisionVault
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`;
  return dateStr;
}

// Returns full years between dateOfBirth and dateOfDeath, or null if either is missing.
function calculateAgeAtDeath(dateOfBirth, dateOfDeath) {
  if (!dateOfBirth || !dateOfDeath) return null;
  const dob = new Date(dateOfBirth + 'T00:00:00');
  const dod = new Date(dateOfDeath + 'T00:00:00');
  if (isNaN(dob.getTime()) || isNaN(dod.getTime())) return null;
  let age = dod.getFullYear() - dob.getFullYear();
  const m = dod.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && dod.getDate() < dob.getDate())) age--;
  return age;
}

function sumAssets(assets) {
  if (!assets?.length) return '';
  const total = assets.reduce((sum, a) => sum + parseFloat(a.net_value || 0), 0);
  if (total === 0) return '';
  return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isRI(stateValue) {
  if (!stateValue) return false;
  const s = stateValue.trim().toLowerCase();
  return s === 'ri' || s === 'rhode island';
}

// Guard against DV data-entry artifacts where middle_name was filled with last_name.
// Strips trailing punctuation before comparing so "Ziegler," also matches "Ziegler".
function safeMI(contact) {
  if (!contact?.middle_name) return '';
  const mn = contact.middle_name.trim();
  const ln = (contact.last_name || '').trim();
  const stripped = (s) => s.replace(/[,.:;]+$/, '').trim();
  return stripped(mn) === stripped(ln) ? '' : mn;
}

function addr(contact) {
  if (!contact) return {};
  if (contact.addresses?.length) return contact.addresses[0];
  if (contact.address1) return {
    street:      contact.address1.street,
    city:        contact.address1.city,
    state:       contact.address1.state,
    postal_code: contact.address1.postal_code,
    full_address: contact.address1.full,
  };
  return {};
}

function phone(contact) {
  if (!contact) return '';
  return contact.phone_numbers?.[0]?.number ?? contact.phone1?.phone ?? '';
}

function email(contact) {
  if (!contact) return '';
  return contact.email_addresses?.[0]?.email ?? contact.email1?.email ?? '';
}

function fullAddr(a) {
  return a.full_address ?? [a.street, a.city, a.state, a.postal_code]
    .filter(Boolean).join(', ');
}

// Safe form field setters
function setText(form, name, value) {
  try { form.getTextField(name).setText(value || ''); } catch (_) {}
}

function setDropdown(form, name, value) {
  try {
    const field = form.getDropdown(name);
    const match = field.getOptions().find(o => o.toLowerCase() === (value || '').toLowerCase());
    if (match) field.select(match);
  } catch (_) {}
}

function setCheckbox(form, name, checked) {
  try {
    const field = form.getCheckBox(name);
    checked ? field.check() : field.uncheck();
  } catch (_) {}
}

// Draw X at a visual checkbox location (for non-AcroForm checkboxes)
function drawX(page, x, y, size = 9) {
  page.drawText('X', { x, y, size, color: rgb(0, 0, 0) });
}

// Fill the standard header present on almost every RI probate form
function fillHeader(form, { decedentName, alias, caseNo, decedentCity },
  { countyField = 'Combo Box 4', cityField = 'Combo Box 5', estateField = '3', aliasField = '4', caseField = '6' } = {}
) {
  const county = cityToCounty(decedentCity);
  if (county) setDropdown(form, countyField, county);
  if (decedentCity) setDropdown(form, cityField, decedentCity);
  setText(form, estateField, decedentName);
  if (aliasField) setText(form, aliasField, alias ?? '');
  if (caseField)  setText(form, caseField,  caseNo  ?? '');
}

// Return the standard case caption fields used by all form fillers and continuation pages
function getMatterCaption(matter, contacts, county = '') {
  const decedent = contacts?.find(c => c.relationship?.type === '1MAIN') ?? matter?.contact_main;
  const decedentName = decedent
    ? [decedent.first_name, decedent.middle_name, decedent.last_name].filter(Boolean).join(' ')
    : '';
  return {
    decedentName,
    docketNumber: matter?.docket_no || '',
    county:       county || matter?.county || '',
  };
}

// Identify the key contacts from a contacts array
function identifyContacts(contacts, matterContactMain, matterContactRep) {
  const decedent       = contacts.find(c => c.relationship?.type === '1MAIN') ?? matterContactMain;
  const representative = contacts.find(c => c.is_client) ?? matterContactRep;
  const spouse         = contacts.find(c => SPOUSE_TYPES.has(c.relationship?.type));
  const heirs          = contacts.filter(c =>
    !NON_HEIR_TYPES.has(c.relationship?.type) && c.id !== spouse?.id
  );
  return { decedent, representative, spouse, heirs };
}

module.exports = {
  TEMPLATES_DIR, FIRM_PROFILE, FIRM, RESIDENT_AGENT,
  NON_HEIR_TYPES, SPOUSE_TYPES,
  MA_CITY_TO_COUNTY, MA_COUNTY_TO_DIVISION,
  getCountyFromAddress,
  cityToCounty, formatDate, calculateAgeAtDeath, sumAssets, isRI,
  addr, phone, email, fullAddr, safeMI,
  setText, setDropdown, setCheckbox, drawX,
  fillHeader, identifyContacts, getMatterCaption,
};
