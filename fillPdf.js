const fs   = require('fs');
const path = require('path');

const { fillPC11  } = require('./forms/pc11');
const { fillPC15  } = require('./forms/pc15');
const { fillPC31A } = require('./forms/pc31a');
const { fillPC31B } = require('./forms/pc31b');
const { fillPC35  } = require('./forms/pc35');
const { fillPC91  } = require('./forms/pc91');
const { fillPC92  } = require('./forms/pc92');
const { mergePdfs } = require('./mergePdfs');

const DOWNLOADS = path.join(__dirname, 'downloads');

const FILLERS = {
  pc11:  fillPC11,
  pc15:  fillPC15,
  pc31a: fillPC31A,
  pc31b: fillPC31B,
  pc35:  fillPC35,
  pc91:  fillPC91,
  pc92:  fillPC92,
};

const LABELS = {
  pc11: 'PC-1.1', pc15: 'PC-1.5',
  pc31a: 'PC-3.1A', pc31b: 'PC-3.1B',
  pc35: 'PC-3.5', pc91: 'PC-9.1', pc92: 'PC-9.2',
};

function ensureDownloads() {
  if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true });
}

function safeMatterName(matter) {
  return (matter.name || String(matter.id)).replace(/[^a-zA-Z0-9 _-]/g, '_');
}

async function saveForm(formId, matter, contacts, assets, opts = {}) {
  ensureDownloads();
  const filler = FILLERS[formId];
  if (!filler) throw new Error(`Unknown form: ${formId}`);
  const { bytes, warnings } = await filler(matter, contacts, assets, opts);
  const filename = `${LABELS[formId]}_${safeMatterName(matter)}.pdf`;
  const outPath  = path.join(DOWNLOADS, filename);
  fs.writeFileSync(outPath, bytes);
  return { filename, outPath, warnings };
}

async function savePackage(matter, contacts, assets, opts = {}) {
  ensureDownloads();
  const { petitionType = 'admin', selectedBeneficiaryIds = null } = opts;
  const o = { petitionType, selectedBeneficiaryIds };

  // Filing order per spec; petition form first, then bond, agent, waiver, attorney
  const order = petitionType === 'probate'
    ? ['pc15', 'pc31a', 'pc35', 'pc91', 'pc92']
    : ['pc11', 'pc31a', 'pc35', 'pc91', 'pc92'];

  const allWarnings = [];
  const buffers     = [];

  for (const formId of order) {
    const { bytes, warnings } = await FILLERS[formId](matter, contacts, assets, o);
    buffers.push(bytes);
    allWarnings.push(...warnings);
  }

  const merged   = await mergePdfs(buffers);
  const label    = petitionType === 'probate' ? 'Probate-Package' : 'Admin-Package';
  const filename = `${label}_${safeMatterName(matter)}.pdf`;
  const outPath  = path.join(DOWNLOADS, filename);
  fs.writeFileSync(outPath, merged);
  return { filename, outPath, warnings: allWarnings };
}

module.exports = { saveForm, savePackage };
