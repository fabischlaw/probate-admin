'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { getAuthHeaders }     = require('../auth');
const { calculateDeadlines } = require('../admin/deadlineCalculator');
const { categorizeMatter }   = require('../admin/detectMatterType');

const DV_BASE      = 'https://api.decisionvault.com/v1';
const ADMIN_FILE   = path.join(__dirname, '../data/administration.json');
const HISTORY_FILE = path.join(__dirname, '../data/alertHistory.json');
const EMAIL_FILE   = path.join(__dirname, '../data/lastAlertEmail.txt');

// Alert severity thresholds — stricter than the deadline calculator's display thresholds
function alertSeverity(daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return null;
  if (daysUntil < 0)   return 'overdue';
  if (daysUntil <= 14) return 'urgent';
  if (daysUntil <= 30) return 'upcoming';
  return null;
}

function loadAdminData() {
  try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); }
  catch { return {}; }
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return {}; }
}

function saveHistory(data) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function saveEmailDraft(text) {
  fs.mkdirSync(path.dirname(EMAIL_FILE), { recursive: true });
  fs.writeFileSync(EMAIL_FILE, text);
}

function detectMatterState(matter, rec) {
  if (rec.matterTypeOverrides?.state) return rec.matterTypeOverrides.state;
  const t = (matter?.quest_internal_type || '').toLowerCase();
  if (t.includes('rhodeisland') || t.includes('rhode island')) return 'RI';
  if (t.includes('massachusetts')) return 'MA';
  return 'MA';
}

function extractDecedentName(matterName) {
  if (!matterName) return matterName;
  const before = matterName.split(' - ')[0].trim();
  return before || matterName;
}

function shouldAlert(alertId, severity, history) {
  const rec = history[alertId];
  if (!rec) return true;
  if (rec.dismissed) return false;
  const hoursSince = (Date.now() - new Date(rec.lastAlertDate).getTime()) / 3600000;
  if (severity === 'overdue' || severity === 'urgent') return hoursSince >= 24;
  return hoursSince >= 24 * 7; // upcoming: re-alert weekly
}

async function fetchMatters() {
  const headers = await getAuthHeaders();
  const res = await axios.get(`${DV_BASE}/matters`, { headers });
  return res.data.results || res.data || [];
}

async function runDeadlineAlertAgent(mattersArg, adminDataArg) {
  const adminData = adminDataArg || loadAdminData();
  const matters   = mattersArg   || await fetchMatters();

  const matterById = Object.fromEntries(matters.map(m => [m.id, m]));
  const history    = loadHistory();
  const now        = new Date().toISOString();
  const alerts     = [];
  const errors     = [];

  const today = new Date(); today.setHours(0, 0, 0, 0);

  for (const [matterId, rec] of Object.entries(adminData)) {
    const matter = matterById[matterId];
    if (!matter) continue;

    if (rec.stage === 'CLOSED') continue;
    if (categorizeMatter(matter.quest_internal_type) === 'planning') continue;

    const keyDates = rec.keyDates || {};
    const hasAnyDate = Object.values(keyDates).some(v => v && v !== 'null');
    if (!hasAnyDate) continue;

    const state      = detectMatterState(matter, rec);
    const hasTrust   = !!(rec.matterTypeOverrides?.hasTrust);
    const matterName = matter.name || matterId;
    const decedentName = extractDecedentName(matterName);

    try {
      const deadlines = calculateDeadlines(keyDates, state, { hasTrust });

      for (const dl of deadlines) {
        if (dl.daysUntil === null) continue;
        const severity = alertSeverity(dl.daysUntil);
        if (!severity) continue;

        const alertId      = `${matterId}:${dl.key}:${dl.dueDate}`;
        const alreadyAlerted = !!history[alertId];

        alerts.push({
          matterId,
          matterName,
          decedentName,
          state,
          deadlineKey:    dl.key,
          deadlineLabel:  dl.label,
          dueDate:        dl.dueDate,
          dueDateDisplay: dl.dueDateDisplay,
          daysRemaining:  dl.daysUntil,
          severity,
          statute:        dl.statute || null,
          alreadyAlerted,
          alertId,
          shouldSend:     shouldAlert(alertId, severity, history),
        });
      }

      // Hearing date
      const hearing = keyDates.nextHearingDate;
      if (hearing) {
        const hDate  = new Date(hearing + 'T00:00:00');
        const days   = Math.round((hDate - today) / 86400000);
        const sev    = alertSeverity(days);
        if (sev) {
          const [y, m, d] = hearing.split('-');
          const alertId   = `${matterId}:hearing:${hearing}`;
          const label     = keyDates.nextHearingDescription
            ? `Hearing: ${keyDates.nextHearingDescription}`
            : 'Court Hearing';
          alerts.push({
            matterId,
            matterName,
            decedentName,
            state,
            deadlineKey:    'hearing',
            deadlineLabel:  label,
            dueDate:        hearing,
            dueDateDisplay: `${m}/${d}/${y}`,
            daysRemaining:  days,
            severity:       sev,
            statute:        null,
            alreadyAlerted: !!history[alertId],
            alertId,
            shouldSend:     shouldAlert(alertId, sev, history),
          });
        }
      }
    } catch (err) {
      errors.push({ matterId, matterName, error: err.message });
    }
  }

  // Sort: overdue → urgent → upcoming, then by due date
  const SEV_ORDER = { overdue: 0, urgent: 1, upcoming: 2 };
  alerts.sort((a, b) => {
    const s = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    return s !== 0 ? s : a.dueDate.localeCompare(b.dueDate);
  });

  const summary = {
    overdue:  alerts.filter(a => a.severity === 'overdue').length,
    urgent:   alerts.filter(a => a.severity === 'urgent').length,
    upcoming: alerts.filter(a => a.severity === 'upcoming').length,
  };

  // Update history for alerts that should be sent
  for (const alert of alerts.filter(a => a.shouldSend)) {
    const existing = history[alert.alertId];
    history[alert.alertId] = {
      firstAlertDate: existing?.firstAlertDate || now,
      lastAlertDate:  now,
      alertCount:     (existing?.alertCount || 0) + 1,
      severity:       alert.severity,
      dismissed:      false,
    };
  }
  saveHistory(history);

  // Email draft (Part 4)
  const runDate  = new Date();
  const nextRun  = new Date(runDate);
  nextRun.setDate(nextRun.getDate() + 1);
  nextRun.setHours(8, 0, 0, 0);

  const dateStr = runDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const bar  = '━'.repeat(52);
  const line = '─'.repeat(40);
  const lines = [
    `DEADLINE ALERT SUMMARY — ${dateStr}`,
    `Fabisch Law Offices — Estate Administration`,
    bar, '',
    `SUMMARY: ${alerts.length} deadline${alerts.length !== 1 ? 's' : ''} require attention`,
    `  ⚠  Overdue:   ${summary.overdue}`,
    `  ●  Urgent:    ${summary.urgent}   (due within 14 days)`,
    `  ○  Upcoming:  ${summary.upcoming}  (due within 30 days)`,
    '', bar, '',
  ];

  const groups = [
    { sev: 'overdue',  heading: 'OVERDUE DEADLINES' },
    { sev: 'urgent',   heading: 'URGENT — Due Within 14 Days' },
    { sev: 'upcoming', heading: 'UPCOMING — Due Within 30 Days' },
  ];

  for (const { sev, heading } of groups) {
    const group = alerts.filter(a => a.severity === sev);
    if (!group.length) continue;
    lines.push(`${heading} (${group.length})`);
    lines.push(line);
    lines.push('');
    for (const a of group) {
      const dayStr = a.daysRemaining < 0
        ? `${Math.abs(a.daysRemaining)} day${Math.abs(a.daysRemaining) !== 1 ? 's' : ''} overdue`
        : `Due in ${a.daysRemaining} day${a.daysRemaining !== 1 ? 's' : ''}`;
      lines.push(`${a.matterName} — ${a.deadlineLabel} — ${dayStr}`);
      lines.push(`Due: ${a.dueDateDisplay}${a.statute ? ' | Statute: ' + a.statute : ''}`);
      lines.push('');
    }
  }

  if (errors.length) {
    lines.push('ERRORS (deadline calculation failed):');
    lines.push(line);
    for (const e of errors) lines.push(`  ${e.matterName}: ${e.error}`);
    lines.push('');
  }

  lines.push(bar);
  lines.push('Generated by Fabisch Law Probate Admin System');
  lines.push(`Run time: ${now}`);
  lines.push(`Next scheduled run: ${nextRun.toLocaleString()}`);

  saveEmailDraft(lines.join('\n'));

  console.log(`[AlertAgent] Scan complete: ${summary.overdue} overdue, ${summary.urgent} urgent, ${summary.upcoming} upcoming | ${errors.length} errors`);
  return { runDate: now, alertCount: alerts.length, alerts, summary, errors };
}

// Allow standalone run: node agents/deadlineAlertAgent.js
if (require.main === module) {
  runDeadlineAlertAgent()
    .then(r => { console.log(JSON.stringify(r.summary, null, 2)); process.exit(0); })
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { runDeadlineAlertAgent, detectMatterState };
