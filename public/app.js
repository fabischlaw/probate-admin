(async () => {
  const mattersList = document.getElementById('matters-list');
  const detailPanel = document.getElementById('detail-panel');

  // Session-scoped beneficiary selections: matterId → Set<contactId>
  const beneficiarySelections = new Map();

  // Kanban state (populated by loadKanban, declared here for IIFE-wide access)
  let kanbanCards = [];
  let kanbanSearch = '';
  let kanbanStateFilter = 'ALL';
  let kanbanDragMatterId = null;
  let kanbanDragFromStage = null;
  let kanbanBoardMode = 'admin';       // 'admin' | 'planning'
  let kanbanCategoryFilter = 'ALL';    // 'ALL' | 'probate' | 'trust' | 'guardianship' | ...
  let kanbanCollapsedAll = false;
  let kanbanCollapsedCols = new Set();
  let kanbanCollapsedCards = new Set();
  const KANBAN_COLUMNS = [
    { id: 'PETITION_PREP',     label: 'Petition Prep',     color: '#6366f1' },
    { id: 'FILED',             label: 'Filed',             color: '#0ea5e9' },
    { id: 'APPOINTED',         label: 'Appointed',         color: '#f59e0b' },
    { id: 'IN_ADMINISTRATION', label: 'In Administration', color: '#8b5cf6' },
    { id: 'CLOSING_PREP',      label: 'Closing Prep',      color: '#f97316' },
    { id: 'CLOSED',            label: 'Closed',            color: '#22c55e' },
  ];
  const PLANNING_KANBAN_COLUMNS = [
    { id: 'INTAKE',    label: 'Intake',    color: '#06b6d4' },
    { id: 'DRAFTING',  label: 'Drafting',  color: '#6366f1' },
    { id: 'REVIEW',    label: 'Review',    color: '#f59e0b' },
    { id: 'SIGNING',   label: 'Signing',   color: '#f97316' },
    { id: 'COMPLETE',  label: 'Complete',  color: '#22c55e' },
  ];
  // Alert state
  let alertData = null;
  let alertsByMatter = new Map(); // matterId → { overdue, urgent, upcoming, items[] }
  // Flags state
  let flagsData = [];
  let flagsByMatter = new Map(); // matterId → flag[]
  // AI settings state
  let aiSettings = {};

  // ── User/auth state ──
  let currentUser        = null;
  let userPermissions    = null;

  async function loadCurrentUser() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) { window.location.href = '/login'; return false; }
      const data  = await res.json();
      currentUser     = data.user;
      userPermissions = data.permissions;
      renderUserInSidebar();
      applyPermissions();
      return true;
    } catch {
      window.location.href = '/login';
      return false;
    }
  }

  function renderUserInSidebar() {
    const el2 = document.getElementById('sidebar-user');
    if (!el2 || !currentUser) return;
    const roleLabels = { attorney: 'Attorney', firm_admin: 'Firm Admin', paralegal: 'Paralegal', va: 'Virtual Assistant' };
    el2.innerHTML = `
      <div style="font-size:0.79rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${currentUser.name}</div>
      <div style="font-size:0.7rem;color:rgba(255,255,255,0.45);margin-top:1px">${roleLabels[currentUser.role] || currentUser.role}</div>
    `;
    const signOutBtn = document.getElementById('sidebar-signout');
    if (signOutBtn) signOutBtn.style.display = 'block';
  }

  function applyPermissions() {
    if (!userPermissions) return;
    if (!userPermissions.canManageAISettings) {
      document.getElementById('ai-features-section')?.style.setProperty('display', 'none');
    }
    if (!userPermissions.canViewAuditLog) {
      document.querySelectorAll('.nav-item[data-view="audit-log"]').forEach(n => n.style.display = 'none');
    }
  }

  async function signOut() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/login';
  }

  // --- Utility ---

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else if (child) node.appendChild(child);
    }
    return node;
  }

  async function apiFetch(path, opts = {}) {
    const fetchOpts = { ...opts };
    if (fetchOpts.body && !fetchOpts.headers) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(path, fetchOpts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function kvRow(key, val) {
    return [el('span', { className: 'key' }, key), el('span', { className: 'val' }, String(val ?? '—'))];
  }

  function makeTable(rows, columns) {
    if (!rows || rows.length === 0) return el('p', { style: 'color:#9ca3af;font-size:.875rem' }, 'None found.');
    const thead = el('thead', {}, el('tr', {}, ...columns.map(c => el('th', {}, c.label))));
    const tbody = el('tbody', {}, ...rows.map(row =>
      el('tr', {}, ...columns.map(c => el('td', {}, String(c.get ? c.get(row) : (row[c.key] ?? '—')))))
    ));
    return el('table', {}, thead, tbody);
  }

  // Relationship types excluded from the will-beneficiary checklist
  const CHECKLIST_EXCLUDE = new Set([
    '1MAIN', '1DIVO',
    '5ATTO', '5CFP', '5CPA', '5OTHE', '5PCP', '5REAL', '5WMAN',
    '4CONT',
  ]);

  // Download a generated PDF; shows warnings as alert after download
  async function downloadPdf(url, fallbackFilename, btn, originalLabel) {
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || res.statusText);
      }
      const warningsHeader = res.headers.get('X-Warnings');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fallbackFilename;
      a.click();
      URL.revokeObjectURL(a.href);
      if (warningsHeader) {
        const warnings = JSON.parse(warningsHeader);
        if (warnings.length) alert(warnings.join('\n\n'));
      }
    } catch (err) {
      alert(`Failed to generate PDF: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // POST to a MA endpoint and stream the response PDF to a browser download.
  // errEl (optional): DOM element that receives error text (shown/hidden automatically).
  async function postAndDownload(btn, url, body, filename, errEl) {
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px"><span class="spinner"></span>Generating…</span>';
    if (errEl) errEl.style.display = 'none';
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const ct  = res.headers.get('content-type') || '';
        const msg = ct.includes('json')
          ? ((await res.json().catch(() => ({}))).error || res.statusText)
          : res.statusText;
        throw new Error(msg);
      }
      const warningsHeader = res.headers.get('X-Warnings');
      const blob = await res.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      if (warningsHeader) {
        const list = JSON.parse(warningsHeader);
        if (list.length) alert('Warnings:\n\n' + list.join('\n\n'));
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = '';
      } else {
        alert('Error generating PDF: ' + err.message);
      }
    } finally {
      btn.disabled  = false;
      btn.innerHTML = origHTML;
    }
  }

  // Build a safe filename component from a string
  function safeFilePart(s) {
    return (s || '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  // ISO date stamp for filenames: YYYY-MM-DD
  function todayStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  // Build the beneficiaries query param from current session selection
  function getBeneficiariesParam(matterId) {
    const sel = beneficiarySelections.get(matterId);
    if (!sel || sel.size === 0) return '';
    return '&beneficiaries=' + [...sel].join(',');
  }

  // ── Bootstrap: authenticate before loading anything ───────────────────────
  const authed = await loadCurrentUser();
  if (!authed) return;

  // Sign out button
  document.getElementById('sidebar-signout')?.addEventListener('click', signOut);

  // Audit log nav item
  document.querySelector('.nav-item[data-view="audit-log"]')?.addEventListener('click', () => {
    showView('audit-log');
    loadAuditLog();
  });

  // --- Load matters list ---

  let matters = [];
  try {
    const data = await apiFetch('/api/matters');
    matters = data.results || [];
    mattersList.innerHTML = '';

    if (matters.length === 0) {
      mattersList.innerHTML = '<li style="color:#9ca3af;padding:.75rem 1rem;font-size:.875rem">No matters found.</li>';
    } else {
      for (const matter of matters) {
        const li = el('li', {},
          el('div', { className: 'matter-name' }, matter.name),
          el('div', { className: 'matter-sub' }, matter.quest_internal_type || '')
        );
        li.dataset.id = matter.id;
        li.addEventListener('click', () => loadMatter(matter.id, li));
        mattersList.appendChild(li);
      }
    }
  } catch (err) {
    mattersList.innerHTML = `<li class="error">Error loading matters: ${err.message}</li>`;
  }

  // ── View routing ──────────────────────────────────────────────────────────

  function showView(view) {
    const isKanban = view.startsWith('kanban');
    document.getElementById('view-kanban').style.display     = isKanban          ? 'flex'   : 'none';
    document.getElementById('view-matters').style.display    = view === 'matters' ? 'grid'   : 'none';
    document.getElementById('view-audit-log').style.display  = view === 'audit-log' ? 'block' : 'none';
    document.querySelectorAll('.nav-item[data-view]').forEach(n => {
      n.classList.toggle('active', n.dataset.view === view);
    });
    if (view === 'kanban-admin') {
      kanbanCategoryFilter = 'ALL';
      const cf = document.getElementById('kanban-category-filter');
      if (cf) cf.value = 'ALL';
      setKanbanBoardMode('admin');
    } else if (view === 'kanban-planning') {
      kanbanCategoryFilter = 'ALL';
      const cf = document.getElementById('kanban-category-filter');
      if (cf) cf.value = 'ALL';
      setKanbanBoardMode('planning');
    } else if (view === 'kanban-guardianship') {
      kanbanCategoryFilter = 'guardianship';
      const cf = document.getElementById('kanban-category-filter');
      if (cf) cf.value = 'guardianship';
      setKanbanBoardMode('admin');
    }
  }

  function setKanbanBoardMode(mode) {
    kanbanBoardMode = mode;
    document.getElementById('tab-admin')?.classList.toggle('active', mode === 'admin');
    document.getElementById('tab-planning')?.classList.toggle('active', mode === 'planning');
    renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
  }

  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => showView(item.dataset.view));
  });

  document.getElementById('tab-admin')?.addEventListener('click', () => {
    kanbanCategoryFilter = 'ALL';
    const cf = document.getElementById('kanban-category-filter');
    if (cf) cf.value = 'ALL';
    setKanbanBoardMode('admin');
  });
  document.getElementById('tab-planning')?.addEventListener('click', () => {
    kanbanCategoryFilter = 'ALL';
    const cf = document.getElementById('kanban-category-filter');
    if (cf) cf.value = 'ALL';
    setKanbanBoardMode('planning');
  });

  // Load kanban on startup
  loadKanban();

  // Toolbar wiring
  document.getElementById('kanban-search').addEventListener('input', e => {
    kanbanSearch = e.target.value;
    renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
  });
  document.getElementById('kanban-state-filter').addEventListener('change', e => {
    kanbanStateFilter = e.target.value;
    renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
  });
  document.getElementById('kanban-category-filter')?.addEventListener('change', e => {
    kanbanCategoryFilter = e.target.value;
    renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
  });
  document.getElementById('kanban-collapse-all')?.addEventListener('click', () => {
    toggleAllCards(!kanbanCollapsedAll);
  });
  document.getElementById('kanban-refresh').addEventListener('click', () => loadKanban(true));

  // Alert bell + panel wiring
  document.getElementById('sidebar-bell')?.addEventListener('click', openAlertPanel);
  document.getElementById('alert-panel-close')?.addEventListener('click', closeAlertPanel);
  document.getElementById('alert-overlay')?.addEventListener('click', closeAlertPanel);

  // Flag icon + panel wiring
  document.getElementById('sidebar-flag')?.addEventListener('click', openFlagPanel);
  document.getElementById('flag-panel-close')?.addEventListener('click', closeFlagPanel);
  document.getElementById('flag-overlay')?.addEventListener('click', closeFlagPanel);

  // AI Features panel toggle (collapse/expand)
  document.getElementById('ai-features-toggle')?.addEventListener('click', () => {
    document.getElementById('ai-features-section')?.classList.toggle('collapsed');
  });

  // AI toggle handlers
  document.getElementById('ai-toggle-alerts')?.addEventListener('change', e => {
    updateAiSetting('AI_DEADLINE_ALERTS', e.target.checked);
    const btn = document.getElementById('ai-run-alerts');
    if (btn) btn.disabled = !e.target.checked;
  });
  document.getElementById('ai-toggle-scanner')?.addEventListener('change', e => {
    updateAiSetting('AI_DOCUMENT_SCANNER', e.target.checked);
    const btn = document.getElementById('ai-run-scanner');
    if (btn) btn.disabled = !e.target.checked;
  });
  document.getElementById('ai-toggle-extraction')?.addEventListener('change', e => {
    updateAiSetting('AI_EXTRACTION', e.target.checked);
  });

  // Run Now buttons
  document.getElementById('ai-run-alerts')?.addEventListener('click', async function() {
    this.disabled = true; this.textContent = '…';
    try { await apiFetch('/api/alerts/run'); await loadAlerts(true); }
    catch (err) { console.warn('Alert run failed:', err.message); }
    this.textContent = '↻ Run'; this.disabled = !aiSettings.AI_DEADLINE_ALERTS;
  });
  document.getElementById('ai-run-scanner')?.addEventListener('click', async function() {
    this.disabled = true; this.textContent = '…';
    try { await apiFetch('/api/scan/run'); await loadFlags(); updateScanStatus(); }
    catch (err) { console.warn('Scanner run failed:', err.message); }
    this.textContent = '↻ Run'; this.disabled = !aiSettings.AI_DOCUMENT_SCANNER;
  });

  // Initial data loads
  loadAlerts();
  loadFlags();
  loadAiSettings();
  updateScanStatus();
  setInterval(() => loadAlerts(), 60 * 60 * 1000);
  setInterval(() => { loadFlags(); updateScanStatus(); }, 5 * 60 * 1000);

  // --- Load matter detail ---

  async function loadMatter(id, listItem) {
    document.querySelectorAll('#matters-list li').forEach(l => l.classList.remove('active'));
    if (listItem) listItem.classList.add('active');
    detailPanel.innerHTML = '<div class="loading">Loading…</div>';

    const [detail, clientsRes, assetsRes, contactsRes] = await Promise.allSettled([
      apiFetch(`/api/matters/${id}`),
      apiFetch(`/api/matters/${id}/clients`),
      apiFetch(`/api/matters/${id}/assets`),
      apiFetch(`/api/matters/${id}/contacts`),
    ]);

    detailPanel.innerHTML = '';

    // Matter detail card
    if (detail.status === 'fulfilled') {
      const m = detail.value;
      const grid = el('div', { className: 'kv-grid' });
      const rep  = m.contact_representative;
      const main = m.contact_main;
      const fields = [
        ['Matter ID',        m.id],
        ['Name',             m.name],
        ['Type',             m.quest_internal_type],
        ['Client Type',      m.client_type],
        ['Open Date',        m.open_date],
        ['Close Date',       m.close_date],
        ['Decedent / Main',  main?.full_name],
        ['Representative',   rep?.full_name],
      ];
      for (const [k, v] of fields) {
        if (v != null) kvRow(k, v).forEach(n => grid.appendChild(n));
      }
      detailPanel.appendChild(
        el('div', { className: 'card' },
          el('h3', {}, 'Matter Details'),
          el('div', { className: 'card-body' }, grid)
        )
      );

      // --- Documents panel (shown above forms for both RI and MA) ---

      const allContacts = contactsRes.status === 'fulfilled'
        ? (contactsRes.value.contacts || [])
        : [];

      const docPanel = buildDocumentPanel(id, allContacts);
      detailPanel.appendChild(docPanel.container);

      // Petition type toggle
      const radioName = `petition-type-${id}`;
      let petitionType = 'admin';

      function makeRadio(value, label, checked) {
        const input = el('input', { type: 'radio', name: radioName, value });
        if (checked) input.setAttribute('checked', '');
        return el('label', {}, input, el('span', {}, label));
      }

      const toggleDiv = el('div', { className: 'petition-toggle' },
        makeRadio('admin',   'Administration (no will)', true),
        makeRadio('probate', 'Probate of Will',          false)
      );

      // Beneficiary checklist (shown only in probate mode)
      let beneficiaryPanel = null;

      function buildBeneficiaryPanel() {
        const details = document.createElement('details');
        details.className = 'beneficiary-panel';
        details.setAttribute('open', '');
        const summary = document.createElement('summary');
        summary.textContent = 'Will Beneficiaries — select all interested parties';
        details.appendChild(summary);

        const listDiv = el('div', { className: 'beneficiary-list' },
          el('div', { className: 'beneficiary-loading' }, 'Loading heir data…')
        );
        details.appendChild(listDiv);

        // Fetch legal heir IDs, then populate checkboxes
        apiFetch(`/api/matters/${id}/heirs`)
          .then(({ legalHeirIds }) => {
            const legalSet = new Set(legalHeirIds);

            // Initialize session selection if not already set
            if (!beneficiarySelections.has(id)) {
              beneficiarySelections.set(id, new Set(legalHeirIds));
            }
            const sel = beneficiarySelections.get(id);

            listDiv.innerHTML = '';

            const checklistContacts = allContacts.filter(c =>
              !CHECKLIST_EXCLUDE.has(c.relationship?.type)
            );

            if (checklistContacts.length === 0) {
              listDiv.appendChild(
                el('div', { className: 'beneficiary-loading' }, 'No contacts available for selection.')
              );
              return;
            }

            for (const contact of checklistContacts) {
              const isHeir = legalSet.has(contact.id);
              const isChecked = sel.has(contact.id);
              const itemId = `bene-${id}-${contact.id}`;

              const checkbox = el('input', { type: 'checkbox', id: itemId });
              if (isChecked) checkbox.setAttribute('checked', '');

              checkbox.addEventListener('change', () => {
                const current = beneficiarySelections.get(id) || new Set();
                if (checkbox.checked) {
                  current.add(contact.id);
                } else {
                  current.delete(contact.id);
                }
                beneficiarySelections.set(id, current);
              });

              const relText = contact.relationship?.short ?? '';
              const labelNode = document.createElement('label');
              labelNode.setAttribute('for', itemId);
              labelNode.appendChild(document.createTextNode(contact.full_name));
              if (relText) {
                const relSpan = el('span', { className: 'rel-badge' }, `(${relText})`);
                labelNode.appendChild(relSpan);
              }
              if (isHeir) {
                const tag = el('span', { className: 'heir-tag' }, 'legal heir');
                labelNode.appendChild(document.createTextNode(' '));
                labelNode.appendChild(tag);
              }

              const item = el('div', { className: 'beneficiary-item' + (isHeir ? ' is-heir' : '') },
                checkbox, labelNode
              );
              listDiv.appendChild(item);
            }
          })
          .catch(() => {
            listDiv.innerHTML = '<div class="beneficiary-loading" style="color:#dc2626">Failed to load heir data.</div>';
          });

        return details;
      }

      // ── Matter Type panel (async — sits above forms) ───────────────────────
      const matterTypeCard = el('div', { className: 'card' });
      matterTypeCard.appendChild(el('h3', {}, 'Matter Type'));
      const matterTypeBody = el('div', { className: 'matter-type-panel' });
      matterTypeBody.appendChild(el('div', { className: 'loading', style: 'font-size:.875rem' }, 'Detecting matter type…'));
      matterTypeCard.appendChild(matterTypeBody);
      detailPanel.appendChild(matterTypeCard);

      // Detected matter type — shared between the panel, admin tab, and MA UI
      let detectedMatterType = null;
      let maSuggestedProceedingType = null;

      // Forms body container
      const formsBody = el('div', { className: 'forms-body' });

      // --- State selector: Rhode Island | Massachusetts | Administration ---
      const riTab    = el('button', { className: 'state-tab active' }, 'Rhode Island');
      const maTab    = el('button', { className: 'state-tab' }, 'Massachusetts');
      const adminTab = el('button', { className: 'state-tab' }, 'Administration');
      const stateSelectorDiv = el('div', { className: 'state-selector' }, riTab, maTab, adminTab);
      formsBody.appendChild(stateSelectorDiv);

      // RI content wrapper
      const riContent = el('div', {});
      formsBody.appendChild(riContent);

      // MA content wrapper (hidden until tab is clicked)
      const maContent = el('div', {});
      maContent.style.display = 'none';
      formsBody.appendChild(maContent);

      // Administration content wrapper
      const adminContent = el('div', {});
      adminContent.style.display = 'none';
      formsBody.appendChild(adminContent);

      let maInitialized    = false;
      let adminInitialized = false;

      function showTab(active) {
        riTab.classList.toggle('active',    active === 'ri');
        maTab.classList.toggle('active',    active === 'ma');
        adminTab.classList.toggle('active', active === 'admin');
        riContent.style.display    = active === 'ri'    ? '' : 'none';
        maContent.style.display    = active === 'ma'    ? '' : 'none';
        adminContent.style.display = active === 'admin' ? '' : 'none';
      }

      riTab.addEventListener('click', () => showTab('ri'));

      maTab.addEventListener('click', () => {
        showTab('ma');
        if (!maInitialized) {
          maInitialized = true;
          buildMaUI(id, m, allContacts, maContent, maSuggestedProceedingType);
        }
      });

      adminTab.addEventListener('click', () => {
        showTab('admin');
        if (!adminInitialized) {
          adminInitialized = true;
          buildAdminUI(id, m, adminContent);
        }
      });

      // --- RI UI (builds into riContent) ---

      function updateFormsUI() {
        // Remove existing beneficiary panel if any
        if (beneficiaryPanel && beneficiaryPanel.parentNode === riContent) {
          riContent.removeChild(beneficiaryPanel);
          beneficiaryPanel = null;
        }

        if (petitionType === 'probate') {
          beneficiaryPanel = buildBeneficiaryPanel();
          // Insert after toggleDiv, before package button
          riContent.insertBefore(beneficiaryPanel, pkgBtn);
        }
      }

      // Listen for petition type changes
      toggleDiv.addEventListener('change', e => {
        if (e.target.type === 'radio') {
          petitionType = e.target.value;
          updateFormsUI();
        }
      });

      // Generate Full Package button
      const pkgLabel = 'Generate Full Package';
      const pkgBtn   = el('button', { className: 'package-btn' }, pkgLabel);
      pkgBtn.addEventListener('click', () => {
        const bparam = petitionType === 'probate' && beneficiarySelections.has(id)
          ? getBeneficiariesParam(id) : '';
        downloadPdf(
          `/api/matters/${id}/generate-package?type=${petitionType}${bparam}`,
          `Package_${m.name || id}.pdf`,
          pkgBtn, pkgLabel
        );
      });

      // Individual form buttons
      const FORMS = [
        { id: 'pc11',  label: 'PC-1.1 Administration Petition' },
        { id: 'pc15',  label: 'PC-1.5 Probate of Will' },
        { id: 'pc31a', label: 'PC-3.1A Bond (Surety Exempt)' },
        { id: 'pc31b', label: 'PC-3.1B Bond with Surety',     onRequest: true },
        { id: 'pc35',  label: 'PC-3.5 Appointment of Agent' },
        { id: 'pc91',  label: 'PC-9.1 Waiver' },
        { id: 'pc92',  label: 'PC-9.2 Attorney of Record' },
      ];

      const formBtnList = el('div', { className: 'form-btn-list' });
      for (const form of FORMS) {
        const btnClass = 'form-btn' + (form.onRequest ? ' on-request' : '');
        const btnLabel = form.onRequest ? `${form.label} — on request` : form.label;
        const btn = el('button', { className: btnClass }, btnLabel);
        btn.addEventListener('click', () => {
          const bparam = petitionType === 'probate' && beneficiarySelections.has(id)
            ? getBeneficiariesParam(id) : '';
          downloadPdf(
            `/api/matters/${id}/generate-${form.id}?type=${petitionType}${bparam}`,
            `${form.label.split(' ')[0]}_${m.name || id}.pdf`,
            btn, btnLabel
          );
        });
        formBtnList.appendChild(btn);
      }

      const indivDetails = document.createElement('details');
      indivDetails.className = 'individual-forms';
      const indivSummary = document.createElement('summary');
      indivSummary.textContent = 'Individual Forms';
      indivDetails.appendChild(indivSummary);
      indivDetails.appendChild(formBtnList);

      riContent.appendChild(toggleDiv);
      riContent.appendChild(pkgBtn);
      riContent.appendChild(indivDetails);

      detailPanel.appendChild(
        el('div', { className: 'card' },
          el('h3', {}, 'Generate Forms'),
          formsBody
        )
      );

      // ── Matter Type Panel (async) ─────────────────────────────────────────
      (function buildMatterTypePanel() {
        function makeSourceBadge(source) {
          return el('span', {
            className: 'matter-type-source-badge' + (source === 'override' ? ' override' : ''),
          }, source === 'override' ? 'Override' : 'From DV');
        }

        function applyMatterTypeToUI(mt) {
          detectedMatterType = mt;

          // Set suggested proceeding type for MA UI lazy init
          maSuggestedProceedingType = mt.proceedingType === 'testate'  ? 'informalTestate'
            : mt.proceedingType === 'intestate' ? 'informalIntestate'
            : null;

          // Reset tab visibility
          riTab.style.display  = '';
          maTab.style.display  = '';

          if (mt.matterTypeDisplay === 'trust') {
            // Trust-only (hasTrust && proceedingType === null): hide form tabs, show admin
            riTab.style.display = 'none';
            maTab.style.display = 'none';
            if (adminContent.style.display === 'none') {
              showTab('admin');
              if (!adminInitialized) { adminInitialized = true; buildAdminUI(id, m, adminContent); }
            }
          } else if (mt.state === 'MA') {
            // MA matter: hide RI tab, auto-switch to MA
            riTab.style.display = 'none';
            if (riContent.style.display !== 'none') {
              showTab('ma');
              if (!maInitialized) { maInitialized = true; buildMaUI(id, m, allContacts, maContent, maSuggestedProceedingType); }
            }
          } else {
            // RI matter: hide MA tab (RI already shown by default)
            maTab.style.display = 'none';
          }
        }

        function renderMatterTypePanel(mt) {
          clearEl(matterTypeBody);

          function makePills(options, currentVal, onSelect) {
            const wrap = el('div', { className: 'matter-type-pills' });
            for (const [val, label, trust] of options) {
              const btn = el('button', {
                className: 'matter-type-pill' + (currentVal === val ? (trust ? ' active-trust' : ' active') : ''),
              }, label);
              btn.addEventListener('click', () => onSelect(val));
              wrap.appendChild(btn);
            }
            return wrap;
          }

          // State row
          const stateRow = el('div', { className: 'matter-type-row' });
          stateRow.appendChild(el('span', { className: 'matter-type-label' }, 'State:'));
          stateRow.appendChild(makePills(
            [['MA', 'Massachusetts'], ['RI', 'Rhode Island']],
            mt.state,
            val => saveOverride({ state: val })
          ));
          stateRow.appendChild(makeSourceBadge(mt.stateSource));
          matterTypeBody.appendChild(stateRow);

          // Matter type selector — five buttons replacing separate proceeding/trust rows
          // Determine which button is active based on proceedingType + hasTrust
          let activeBtn = null;
          if (mt.hasTrust && mt.proceedingType === null) activeBtn = 'trust';
          else if (mt.hasTrust && mt.proceedingType === 'testate') activeBtn = 'probate_and_trust';
          else if (!mt.hasTrust && mt.proceedingType === 'testate') activeBtn = 'testate';
          else if (!mt.hasTrust && mt.proceedingType === 'intestate') activeBtn = 'intestate';

          const typeSelectorRow = el('div', { className: 'matter-type-row matter-type-selector' });
          typeSelectorRow.appendChild(el('span', { className: 'matter-type-label' }, 'Matter Type:'));
          const btnWrap = el('div', { className: 'matter-type-pills' });

          const typeButtons = [
            { key: 'testate',          label: 'Testate Probate',      trust: false },
            { key: 'intestate',        label: 'Intestate Probate',    trust: false },
            { key: 'trust',            label: 'Trust Administration', trust: true  },
            { key: 'probate_and_trust',label: 'Probate + Trust',      trust: true  },
            { key: null,               label: 'Unknown — Set Manually', trust: false },
          ];

          for (const { key, label: btnLabel, trust } of typeButtons) {
            const isActive = key === null ? activeBtn === null : activeBtn === key;
            const btn = el('button', {
              className: 'matter-type-pill' + (isActive ? (trust ? ' active-trust' : ' active') : ''),
            }, btnLabel);
            btn.addEventListener('click', () => {
              if (key === 'testate')           saveOverride({ hasTrust: false, proceedingType: 'testate' });
              else if (key === 'intestate')    saveOverride({ hasTrust: false, proceedingType: 'intestate' });
              else if (key === 'trust')        saveOverride({ hasTrust: true,  proceedingType: null });
              else if (key === 'probate_and_trust') saveOverride({ hasTrust: true, proceedingType: 'testate' });
              else                             saveOverride({ _clearOverrides: true });
            });
            btnWrap.appendChild(btn);
          }
          typeSelectorRow.appendChild(btnWrap);
          typeSelectorRow.appendChild(makeSourceBadge(
            (mt.overrides.proceedingType !== undefined || mt.overrides.hasTrust !== undefined) ? 'override' : 'dv'
          ));
          matterTypeBody.appendChild(typeSelectorRow);

          // Testing Mode toggle
          const testRow = el('div', { className: 'matter-type-row', style: 'margin-top:0.35rem;align-items:center;gap:0.5rem' });
          const testCb  = el('input', { type: 'checkbox', id: 'mt-testing-mode-cb', style: 'cursor:pointer' });
          testCb.checked = testingMode;
          testCb.addEventListener('change', () => {
            testingMode = testCb.checked;
            const banner = matterTypeBody.querySelector('.mt-testing-banner');
            if (banner) banner.style.display = testingMode ? '' : 'none';
          });
          testRow.appendChild(testCb);
          testRow.appendChild(el('label', { for: 'mt-testing-mode-cb',
            style: 'font-size:0.72rem;color:#9ca3af;cursor:pointer;user-select:none' }, 'Testing mode (skip confirmation)'));
          matterTypeBody.appendChild(testRow);
          const testBanner = el('div', { className: 'mt-testing-banner' }, '⚠ Testing mode — type changes save without confirmation.');
          testBanner.style.display = testingMode ? '' : 'none';
          matterTypeBody.appendChild(testBanner);

          // Will status prompt when hasWill is unknown (null)
          if (mt.hasWill === null && mt.matterTypeDisplay !== 'trust') {
            const willPrompt = el('div', { className: 'matter-type-will-prompt' },
              'Will status unknown — no will document found in DecisionVault.'
            );
            const willBtns = el('div', { className: 'matter-type-pills', style: 'margin-top:0.35rem' });
            const hasWillBtn = el('button', { className: 'matter-type-pill' }, 'Has Will');
            const noWillBtn  = el('button', { className: 'matter-type-pill' }, 'No Will');
            hasWillBtn.addEventListener('click', () => saveOverride({ hasWill: true,  proceedingType: 'testate' }));
            noWillBtn.addEventListener('click',  () => saveOverride({ hasWill: false, proceedingType: 'intestate' }));
            willBtns.appendChild(hasWillBtn);
            willBtns.appendChild(noWillBtn);
            willPrompt.appendChild(willBtns);
            matterTypeBody.appendChild(willPrompt);
          }

          // Ancillary row (only when detected or overridden)
          if (mt.isAncillary || mt.overrides.isAncillary !== undefined) {
            const ancRow = el('div', { className: 'matter-type-row' });
            ancRow.appendChild(el('span', { className: 'matter-type-label' }, 'Ancillary:'));
            ancRow.appendChild(makePills(
              [[true, 'Yes'], [false, 'No']],
              mt.isAncillary,
              val => saveOverride({ isAncillary: val })
            ));
            ancRow.appendChild(makeSourceBadge(mt.overrides.isAncillary !== undefined ? 'override' : 'dv'));
            matterTypeBody.appendChild(ancRow);
          }

          // Trust-only notice
          if (mt.matterTypeDisplay === 'trust') {
            matterTypeBody.appendChild(el('div', { className: 'matter-type-trust-warning' },
              'Trust-only matter — Form tabs hidden. Use the Administration tab for task tracking.'
            ));
          }
        }

        let testingMode = false;

        function showMatterTypeConfirmModal(confirmData) {
          const overlay = el('div', { className: 'admin-letter-modal-overlay' });
          const modal   = el('div', { className: 'admin-letter-modal' });
          modal.appendChild(el('div', { className: 'admin-letter-modal-header' },
            el('span', { className: 'admin-letter-modal-title' }, '⚠ Change Matter Type?')
          ));
          const body = el('div', { className: 'admin-letter-modal-body mt-confirm-modal', style: 'padding:1rem' });
          const mkRow = (lbl, val) => el('div', { className: 'change-row' },
            el('span', { className: 'change-label' }, lbl),
            el('span', { className: 'change-value' }, val)
          );
          body.appendChild(mkRow('Current:', confirmData.currentDisplay));
          body.appendChild(mkRow('Proposed:', confirmData.proposedDisplay));
          const impacts = el('div', { style: 'margin-top:0.65rem;color:#6b7280;font-size:0.8rem;line-height:1.7' });
          ['Recalculate task checklist', 'Update flag rules', 'Recalculate deadlines']
            .forEach(s => impacts.appendChild(el('div', {}, `• ${s}`)));
          body.appendChild(impacts);
          modal.appendChild(body);
          const footer = el('div', { className: 'admin-letter-modal-footer', style: 'gap:0.5rem' });
          const cancelBtn  = el('button', { className: 'admin-copy-btn', style: 'background:#f3f4f6;color:#374151' }, 'Cancel');
          const confirmBtn = el('button', { className: 'admin-copy-btn' }, 'Confirm Change');
          cancelBtn.addEventListener('click', async () => {
            overlay.remove();
            apiFetch(`/api/admin/matter/${id}/type/confirm`, { method: 'POST', body: JSON.stringify({ confirmed: false }) })
              .then(mt => { renderMatterTypePanel(mt); applyMatterTypeToUI(mt); }).catch(() => {});
          });
          confirmBtn.addEventListener('click', async () => {
            confirmBtn.disabled = true; confirmBtn.textContent = '…';
            try {
              const mt = await apiFetch(`/api/admin/matter/${id}/type/confirm`, {
                method: 'POST', body: JSON.stringify({ confirmed: true }) });
              overlay.remove();
              renderMatterTypePanel(mt); applyMatterTypeToUI(mt);
              loadTasks();
            } catch (err) {
              confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Change';
              alert('Error: ' + err.message);
            }
          });
          footer.appendChild(cancelBtn); footer.appendChild(confirmBtn);
          modal.appendChild(footer);
          overlay.appendChild(modal);
          overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
          document.body.appendChild(overlay);
        }

        function saveOverride(changes) {
          const payload = { ...changes };
          if (testingMode) payload._testingMode = true;
          apiFetch(`/api/admin/matter/${id}/type`, { method: 'POST', body: JSON.stringify(payload) })
            .then(result => {
              if (result.requiresConfirmation) {
                showMatterTypeConfirmModal(result);
              } else {
                renderMatterTypePanel(result); applyMatterTypeToUI(result);
              }
            })
            .catch(err => console.error('Matter type save failed:', err));
        }

        apiFetch(`/api/admin/matter/${id}/type`)
          .then(mt => { renderMatterTypePanel(mt); applyMatterTypeToUI(mt); })
          .catch(() => {
            clearEl(matterTypeBody);
            matterTypeBody.appendChild(el('p', {
              style: 'font-size:.875rem;color:#9ca3af;padding:0.25rem 0',
            }, 'Type detection unavailable — check server connection.'));
          });
      })();
    }

    // Clients card
    {
      const raw  = clientsRes.status === 'fulfilled' ? clientsRes.value : null;
      const rows = raw?.contacts || [];
      detailPanel.appendChild(
        el('div', { className: 'card' },
          el('h3', {}, 'Clients'),
          el('div', { className: 'card-body' },
            clientsRes.status === 'rejected'
              ? el('p', { className: 'error' }, `Error: ${clientsRes.reason.message}`)
              : makeTable(rows, [
                  { key: 'full_name', label: 'Name' },
                  { label: 'Email',   get: r => r.email_addresses?.[0]?.email ?? '—' },
                  { label: 'Phone',   get: r => r.phone_numbers?.[0]?.number  ?? '—' },
                  { label: 'Address', get: r => r.addresses?.[0]?.full_address ?? '—' },
                ])
          )
        )
      );
    }

    // Assets card
    {
      const raw  = assetsRes.status === 'fulfilled' ? assetsRes.value : null;
      const rows = raw?.assets || [];
      detailPanel.appendChild(
        el('div', { className: 'card' },
          el('h3', {}, 'Assets'),
          el('div', { className: 'card-body' },
            assetsRes.status === 'rejected'
              ? el('p', { className: 'error' }, `Error: ${assetsRes.reason.message}`)
              : makeTable(rows, [
                  { label: 'Description', get: r => r.additional_fields?.find(f => f.prompt === 'Bank')?.answer ?? r.identifier_label ?? '—' },
                  { label: 'Owner',       get: r => r.owner_value ?? '—' },
                  { label: 'Balance / Value', get: r => `${r.credit_label ?? ''}: ${r.credit_value ?? '—'}` },
                  { key: 'net_value',    label: 'Net Value' },
                ])
          )
        )
      );
    }

    // Contacts card
    {
      const raw  = contactsRes.status === 'fulfilled' ? contactsRes.value : null;
      const rows = raw?.contacts || [];
      detailPanel.appendChild(
        el('div', { className: 'card' },
          el('h3', {}, 'Contacts'),
          el('div', { className: 'card-body' },
            contactsRes.status === 'rejected'
              ? el('p', { className: 'error' }, `Error: ${contactsRes.reason.message}`)
              : makeTable(rows, [
                  { key: 'full_name', label: 'Name' },
                  { label: 'Role',    get: r => r.relationship?.short ?? (r.is_client ? 'Client' : '—') },
                  { label: 'Email',   get: r => r.email_addresses?.[0]?.email ?? '—' },
                  { label: 'Phone',   get: r => r.phone_numbers?.[0]?.number  ?? '—' },
                ])
          )
        )
      );
    }
  }
  // =========================================================================
  // DOCUMENT PANEL (shared — appears for both RI and MA matters)
  // =========================================================================

  // Registry: matterId → { applyExtraction: fn }  (filled in by buildMaUI when MA tab opens)
  const matterMaCallbacks = new Map();

  function buildDocumentPanel(matterId, allContacts) {
    // ── Helpers ──────────────────────────────────────────────────────────────
    function fileIcon(filename) {
      const f = (filename || '').toLowerCase();
      if (f.endsWith('.pdf')) return '📄';
      if (f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')) return '🖼️';
      return '📎';
    }

    function typeBadge(type) {
      const style = {
        WILL:       'background:#dcfce7;color:#15803d;',
        DEATH_CERT: 'background:#e0f2fe;color:#0369a1;',
        OTHER:      'background:#f3f4f6;color:#6b7280;',
      }[type] || 'background:#f3f4f6;color:#6b7280;';
      const label = { WILL:'WILL', DEATH_CERT:'DEATH CERT', OTHER:'OTHER' }[type] || type;
      return el('span', { style: `font-size:0.7rem;font-weight:600;padding:1px 6px;border-radius:3px;${style}` }, label);
    }

    function sizeKB(bytes) { return Math.round((bytes || 0) / 1024) + ' KB'; }

    function fuzzyNameMatch(nameA, nameB) {
      const norm = s => (s || '').toLowerCase().replace(/[.,\-']/g, ' ').replace(/\s+/g, ' ').trim();
      const a = norm(nameA), b = norm(nameB);
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.includes(b) || b.includes(a)) return true;
      const tA = a.split(' '), tB = b.split(' ');
      return tA[tA.length-1] === tB[tB.length-1] && tA[0][0] === tB[0][0];
    }

    // ── State ────────────────────────────────────────────────────────────────
    const extractState = {}; // documentId → { status:'idle'|'loading'|'done'|'error', result, error }
    let docsData = null;     // full API response
    const AUTO_POPULATED = {}; // toggleId → documentFilename (for badge display)

    // ── DOM skeleton ─────────────────────────────────────────────────────────
    const wrapper  = document.createElement('details');
    wrapper.className = 'individual-forms';
    // collapsed by default — no `open` attribute

    const summary = document.createElement('summary');
    summary.textContent = 'DOCUMENTS (loading…)';
    wrapper.appendChild(summary);

    function updateSummary() {
      if (!docsData) { summary.textContent = 'DOCUMENTS (loading…)'; return; }
      const nonDup = docsData.documents.filter(d => !d.isDuplicate);
      const n = nonDup.length;
      const hasWillDoc      = nonDup.some(d => d.type === 'WILL');
      const hasDeathCertDoc = nonDup.some(d => d.type === 'DEATH_CERT');
      const indicators = [
        hasWillDoc      ? 'Will ✓'       : '',
        hasDeathCertDoc ? 'Death Cert ✓' : '',
      ].filter(Boolean).join(' · ');
      summary.textContent = `DOCUMENTS (${n} file${n !== 1 ? 's' : ''}${indicators ? ' · ' + indicators : ''})`;
    }

    const cardBody = el('div', { style: 'padding:0.75rem' });
    wrapper.appendChild(cardBody);

    const listDiv  = el('div', {});
    const verifDiv = el('div', {});
    cardBody.appendChild(listDiv);
    cardBody.appendChild(verifDiv);

    // ── Render functions ─────────────────────────────────────────────────────

    function renderStatus(docId) {
      const s = extractState[docId] || { status: 'idle' };
      const dot = el('span', {
        style: `width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px;` +
               { idle:'background:#9ca3af', loading:'background:#3b82f6;animation:ma-spin 0.7s linear infinite',
                 done:'background:#16a34a', error:'background:#dc2626', disabled:'background:#d1d5db' }[s.status],
      });
      return dot;
    }

    function renderExtractBtn() {
      const btn = el('button', {
        className: 'form-btn on-request',
        style: 'font-size:0.72rem;padding:2px 9px;opacity:0.5;cursor:not-allowed',
        title: 'AI extraction coming soon — requires API key setup',
      }, 'Extract');
      btn.disabled = true;
      return btn;
    }

    function renderDocList() {
      clearEl(listDiv);
      if (!docsData) {
        listDiv.appendChild(el('div', { className: 'loading', style: 'font-size:.875rem' }, 'Loading documents…'));
        return;
      }

      const nonDup = docsData.documents.filter(d => !d.isDuplicate);
      if (nonDup.length === 0) {
        listDiv.appendChild(el('p', { style: 'color:#9ca3af;font-size:.875rem' }, 'No documents found.'));
        return;
      }

      const table = el('div', { style: 'display:flex;flex-direction:column;gap:5px' });

      for (const doc of nonDup) {
        const row = el('div', {
          style: 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6;flex-wrap:wrap',
        },
          el('span', { style: 'font-size:1.1rem' }, fileIcon(doc.filename)),
          el('span', { style: 'flex:1;min-width:150px;font-size:0.82rem;word-break:break-all' }, doc.filename),
          typeBadge(doc.type),
          el('span', { style: 'font-size:0.75rem;color:#6b7280' }, sizeKB(doc.size)),
          renderExtractBtn(),
        );
        table.appendChild(row);
      }

      // Duplicate note
      if (docsData.summary.duplicatesFound > 0) {
        table.appendChild(el('p', {
          style: 'font-size:0.72rem;color:#9ca3af;margin:6px 0 0',
        }, `${docsData.summary.duplicatesFound} duplicate upload${docsData.summary.duplicatesFound > 1 ? 's' : ''} detected and hidden.`));
      }

      listDiv.appendChild(table);
    }

    // ── On extraction complete ───────────────────────────────────────────────

    function onExtractionComplete(doc, result) {
      // Notify MA UI (if open)
      const cb = matterMaCallbacks.get(matterId);
      if (cb) cb.applyExtraction(result, doc.filename);

      // Re-render verification
      renderVerificationPanel();
    }

    function renderVerificationPanel() {
      clearEl(verifDiv);

      const allResults = Object.entries(extractState)
        .filter(([, s]) => s.status === 'done')
        .map(([docId, s]) => ({ docId, result: s.result }));

      if (allResults.length === 0) return;

      const panel = el('div', { style: 'margin-top:1rem;border-top:1px solid #e5e7eb;padding-top:0.75rem' });
      panel.appendChild(el('div', { style: 'font-size:0.8rem;font-weight:700;color:#374151;margin-bottom:0.5rem;text-transform:uppercase;letter-spacing:0.05em' }, 'Document Verification'));

      for (const { result } of allResults) {
        if (!result?.extracted) continue;
        const d = result.extracted;
        const section = el('div', { style: 'margin-bottom:0.75rem' });
        section.appendChild(el('div', { style: 'font-size:0.78rem;font-weight:600;color:#6b7280;margin-bottom:4px' }, result.filename));

        if (result.type === 'WILL') {
          const dvDecedent = allContacts.find(c => c.relationship?.type === '1MAIN' || c.relationship?.type === '0CLNT');
          const dvRep = allContacts.find(c => c.is_client);
          const rows = [
            ['Will date',       d.willDate || '—'],
            ['Testator',        d.testatorName || '—'],
            ['PR nominee(s)',   (d.prNominees || []).map(p => p.name).join(', ') || '—'],
            ['Sureties waived', d.suretiesWaived ? 'Yes' : 'No'],
            ['Nomination power', d.nominationPowerGranted ? 'Yes' : 'No'],
            ['Attestation clause', d.hasAttestationClause ? 'Yes' : 'No'],
            ['Self-proving',    d.selfProving ? 'Yes' : 'No'],
          ];
          for (const [k, v] of rows) {
            section.appendChild(el('div', { style: 'display:flex;gap:8px;font-size:0.78rem;margin-bottom:2px' },
              el('span', { style: 'color:#6b7280;width:130px;flex-shrink:0' }, k + ':'),
              el('span', {}, v)
            ));
          }
          if (d.notes?.length) {
            for (const note of d.notes) {
              section.appendChild(el('div', { style: 'font-size:0.75rem;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:3px;padding:2px 6px;margin-top:4px' }, '⚠ ' + note));
            }
          }

          // Devisee cross-check
          if (d.devisees?.length) {
            section.appendChild(renderDeviseeCrossCheck(d.devisees, allContacts));
          }
        }

        if (result.type === 'DEATH_CERT') {
          const dvDec = allContacts.find(c => c.relationship?.type === '1MAIN');
          function matchIcon(extracted, dvVal) {
            if (!dvVal) return '⚠️';
            return (extracted || '').toLowerCase().includes((dvVal || '').toLowerCase().split(' ')[0]) ? '✅' : '⚠️';
          }
          const rows = [
            ['Name on cert',    d.decedentName, matchIcon(d.decedentName, dvDec?.full_name)],
            ['Date of death',   d.dateOfDeath, ''],
            ['Domicile',        d.domicileAtDeath, ''],
            ['Cause of death',  d.causeOfDeath, d.isHomicideOrPending ? '🔴' : ''],
            ['Manner of death', d.mannerOfDeath, ''],
          ];
          for (const [k, v, icon] of rows) {
            section.appendChild(el('div', { style: 'display:flex;gap:8px;font-size:0.78rem;margin-bottom:2px' },
              el('span', { style: 'color:#6b7280;width:130px;flex-shrink:0' }, k + ':'),
              el('span', {}, (icon ? icon + ' ' : '') + (v || '—'))
            ));
          }
          if (d.isHomicideOrPending) {
            section.appendChild(el('div', { style: 'font-size:0.75rem;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;border-radius:3px;padding:2px 6px;margin-top:4px' },
              '🔴 Cause of death is pending or homicide — MPC 475 required'));
          }
        }

        panel.appendChild(section);
      }

      verifDiv.appendChild(panel);
    }

    function renderDeviseeCrossCheck(devisees, contacts) {
      const wrap = el('div', { style: 'margin-top:8px' });
      wrap.appendChild(el('div', { style: 'font-size:0.75rem;font-weight:700;color:#374151;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em' }, 'Devisee Cross-Check'));

      const DEVISEE_TYPES = new Set(['2SON','2DATR','2ADOP','2ADTD','3GSON','3GDTR','3FATH','3MOTH',
        '3BROT','3SIST','3SIBL','3AUNT','3UCLE','3NIEC','3NEPW','3COUS','3OTHE','4FRIE','2SDTR','2SSON','1MARR','1WIDW','3LIFP','0CLNT']);
      const dvDevisees = contacts.filter(c => DEVISEE_TYPES.has(c.relationship?.type));

      // header row
      const headerRow = el('div', { style: 'display:grid;grid-template-columns:1fr 0.7fr 1fr 1.2fr;gap:4px;font-size:0.7rem;font-weight:700;color:#6b7280;padding:3px 0;border-bottom:1px solid #e5e7eb;margin-bottom:3px' },
        el('span', {}, 'Name (from will)'),
        el('span', {}, 'Bequest type'),
        el('span', {}, 'In DecisionVault'),
        el('span', {}, 'Status')
      );
      wrap.appendChild(headerRow);

      const unmatchedWill = [];

      for (const dev of devisees) {
        const bqType = dev.isResiduary ? 'Residuary' : dev.isSpecific ? 'Specific bequest' : 'Bequest';
        const match = dvDevisees.find(c => fuzzyNameMatch(dev.name, c.full_name));
        let dvCell, status;

        if (dev.isEntity || dev.isPourOverTrust) {
          dvCell = el('span', { style: 'color:#1d4ed8' }, 'ℹ️ Entity');
          status = el('span', { style: 'color:#1d4ed8;font-size:0.72rem' }, dev.isPourOverTrust ? 'Pour-over trust — list trustee' : 'Entity — list trustee/officer');
        } else if (match) {
          dvCell  = el('span', { style: 'color:#16a34a' }, '✅ ' + (match.full_name || match.first_name));
          status  = el('span', { style: 'color:#16a34a' }, '✅');
        } else {
          dvCell  = el('span', { style: 'color:#dc2626' }, '❌ Not found');
          status  = el('span', { style: 'color:#d97706' }, '⚠️ Not in DV');
          unmatchedWill.push(dev);
        }

        wrap.appendChild(el('div', {
          style: 'display:grid;grid-template-columns:1fr 0.7fr 1fr 1.2fr;gap:4px;font-size:0.72rem;padding:3px 0;border-bottom:1px solid #f3f4f6;align-items:start',
        }, el('span', {}, dev.name), el('span', {}, bqType), dvCell, status));
      }

      // DV contacts not found in will
      for (const c of dvDevisees) {
        if (devisees.find(d => fuzzyNameMatch(d.name, c.full_name))) continue;
        if (c.relationship?.type === '0CLNT') continue;
        wrap.appendChild(el('div', {
          style: 'display:grid;grid-template-columns:1fr 0.7fr 1fr 1.2fr;gap:4px;font-size:0.72rem;padding:3px 0;border-bottom:1px solid #f3f4f6;color:#dc2626;align-items:start',
        },
          el('span', { style: 'color:#374151' }, c.full_name + ' (DV only)'),
          el('span', {}, '—'),
          el('span', { style: 'color:#16a34a' }, '✅ ' + c.full_name),
          el('span', {}, '❌ Not in will')
        ));
      }

      // "Add missing to MPC-163" button
      if (unmatchedWill.length > 0) {
        const addBtn = el('button', { className: 'form-btn', style: 'margin-top:6px;font-size:0.72rem;padding:2px 9px' },
          `Add ${unmatchedWill.length} missing devisee${unmatchedWill.length > 1 ? 's' : ''} to MPC-163`
        );
        addBtn.addEventListener('click', () => {
          const cb = matterMaCallbacks.get(matterId);
          if (cb) cb.addWillDevisees(unmatchedWill);
          addBtn.textContent = 'Added ✓';
          addBtn.disabled = true;
        });
        wrap.appendChild(addBtn);
      }

      return wrap;
    }

    // ── Initial fetch ────────────────────────────────────────────────────────

    renderDocList(); // show loading spinner immediately

    apiFetch(`/api/matters/${matterId}/documents`)
      .then(data => {
        docsData = data;
        updateSummary();
        renderDocList();
      })
      .catch(err => {
        clearEl(listDiv);
        listDiv.appendChild(el('p', { className: 'error' }, 'Failed to load documents: ' + err.message));
      });

    return {
      container: wrapper,
      // Called by buildMaUI to register toggle-update callbacks
      registerMaCallback(cb) { matterMaCallbacks.set(matterId, cb); },
      // Called externally to replay any already-completed extractions into a newly opened MA panel
      replayExtractions() {
        const cb = matterMaCallbacks.get(matterId);
        if (!cb) return;
        for (const [docId, s] of Object.entries(extractState)) {
          if (s.status === 'done') {
            const docMeta = docsData?.documents?.find(d => d.document_id === docId);
            if (docMeta) cb.applyExtraction(s.result, docMeta.filename);
          }
        }
      },
    };
  }

  // =========================================================================
  // MASSACHUSETTS UI
  // =========================================================================

  // --- Static data (mirrors forms/maFormSets.js) ---

  const MA_FORM_SETS_CLIENT = {
    voluntary: {
      label: "Voluntary Administration", fee: 115,
      always: ["MPC-170"],
      conditional: { "MPC-485": "domicileMismatch", "MPC-475": "causeOfDeathPending" }
    },
    informalIntestate: {
      label: "Informal Probate — Intestate", fee: 390,
      always: ["MPC-150","MPC-162","MPC-550","MPC-750","MPC-801"],
      requiredUnlessAllAssent: ["MPC-470"],
      conditional: { "MPC-455":"renunciationOrNominationOrWaiver","MPC-485":"domicileMismatch","MPC-475":"causeOfDeathPending","MPC-551":"postAllowance" }
    },
    informalTestate: {
      label: "Informal Probate — Testate", fee: 390,
      always: ["MPC-150","MPC-162","MPC-163","MPC-550","MPC-750","MPC-801"],
      requiredUnlessAllAssent: ["MPC-470"],
      conditional: { "MPC-455":"renunciationOrNominationOrWaiver","MPC-485":"domicileMismatch","MPC-475":"causeOfDeathPending","MPC-551":"postAllowance" }
    },
    formalIntestate: {
      label: "Formal Probate — Intestate", fee: 405,
      always: ["MPC-160","MPC-162","MPC-560","MPC-755","MPC-801"],
      requiredUnlessAllAssent: ["MPC-470"],
      conditional: { "MPC-455":"renunciationOrNominationOrWaiver","MPC-485":"domicileMismatch","MPC-475":"causeOfDeathPending","CCF-407":"attorneyAppearing" }
    },
    formalTestate: {
      label: "Formal Probate — Testate", fee: 405,
      always: ["MPC-160","MPC-162","MPC-163","MPC-560","MPC-755","MPC-801"],
      requiredUnlessAllAssent: ["MPC-470"],
      conditional: { "MPC-455":"renunciationOrNominationOrWaiver","MPC-480":"noAttestationClause","MPC-485":"domicileMismatch","MPC-475":"causeOfDeathPending","CCF-407":"attorneyAppearing" }
    },
    lateAndLimited: {
      label: "Late & Limited Formal", fee: 405,
      always: ["MPC-161","MPC-162","MPC-560","MPC-757","MPC-801"],
      requiredUnlessAllAssent: ["MPC-470"],
      conditional: { "MPC-163":"testate","MPC-455":"renunciationOrNominationOrWaiver","MPC-480":"noAttestationClause","MPC-485":"domicileMismatch","MPC-475":"causeOfDeathPending","CCF-407":"attorneyAppearing" },
      warning: "PR authority is LIMITED — can only confirm title in successors and pay admin expenses. Cannot sell real estate. Letters must note this limitation."
    }
  };

  const MA_FORM_LABELS_CLIENT = {
    "MPC-150":"MPC 150","MPC-160":"MPC 160","MPC-161":"MPC 161",
    "MPC-162":"MPC 162","MPC-163":"MPC 163","MPC-170":"MPC 170",
    "MPC-455":"MPC 455","MPC-470":"MPC 470","MPC-475":"MPC 475",
    "MPC-480":"MPC 480","MPC-485":"MPC 485","MPC-550":"MPC 550",
    "MPC-551":"MPC 551","MPC-560":"MPC 560","MPC-750":"MPC 750",
    "MPC-755":"MPC 755","MPC-757":"MPC 757","MPC-801":"MPC 801",
    "CCF-407":"CCF 4/07","MPC-850":"MPC 850","MPC-851":"MPC 851",
    "MPC-853":"MPC 853","MPC-854":"MPC 854","MPC-855":"MPC 855",
    "MPC-857":"MPC 857","MPC-360":"MPC 360","MPC-505a":"MPC 505a"
  };

  const MA_FORM_FULL_LABELS = {
    "MPC-150":"MPC 150 — Petition for Informal Probate/Appointment",
    "MPC-160":"MPC 160 — Petition for Formal Probate/Appointment",
    "MPC-161":"MPC 161 — Petition for Late & Limited Formal",
    "MPC-162":"MPC 162 — Surviving Spouse, Children, Heirs at Law",
    "MPC-163":"MPC 163 — Devisees",
    "MPC-170":"MPC 170 — Voluntary Administration Statement",
    "MPC-455":"MPC 455 — Assent/Waiver/Renunciation/Nomination",
    "MPC-470":"MPC 470 — Military Affidavit",
    "MPC-475":"MPC 475 — Cause of Death Affidavit",
    "MPC-480":"MPC 480 — Affidavit of Witness to Will",
    "MPC-485":"MPC 485 — Affidavit of Domicile",
    "MPC-550":"MPC 550 — Notice of Informal Probate & Return of Service",
    "MPC-551":"MPC 551 — Informal Probate Publication Notice",
    "MPC-560":"MPC 560 — Citation (issued by court upon filing)",
    "MPC-750":"MPC 750 — Order of Informal Probate/Appointment",
    "MPC-755":"MPC 755 — Decree and Order on Formal Adjudication",
    "MPC-757":"MPC 757 — Decree and Order — Late & Limited",
    "MPC-801":"MPC 801 — Bond",
    "CCF-407":"CCF 4/07 — Uniform Counsel Certification"
  };

  // Forms that are issued by the court upon filing — not pre-filled templates.
  const COURT_ISSUED_FORMS = new Set(['MPC-560']);

  // --- Toggle definitions ---

  const MA_PROC_TYPES = [
    { id: 'voluntary',        label: 'Voluntary Admin' },
    { id: 'informalIntestate',label: 'Informal — No Will' },
    { id: 'informalTestate',  label: 'Informal — With Will' },
    { id: 'formalIntestate',  label: 'Formal — No Will' },
    { id: 'formalTestate',    label: 'Formal — With Will' },
    { id: 'lateAndLimited',   label: 'Late & Limited' },
  ];

  // showWhen(proceedingType) → bool
  // warningIfYes / warningIfNo → amber banner text when triggered
  // forcesFormalOnYes / forcesFormalOnNo → auto-switch to appropriate Formal type
  // disqualifiesVoluntaryOnNo → auto-switch to informalIntestate
  const MA_TOGGLE_DEFS = [
    // Always shown
    { id:'domicileMatches',      label:"Does domicile on death certificate match decedent's actual domicile?",  showWhen:()=>true,
      warningIfNo:"MPC 485 (Affidavit of Domicile) will be required." },
    { id:'causeOfDeathPending',  label:"Is cause of death listed as pending or homicide?",                      showWhen:()=>true,
      warningIfYes:"MPC 475 (Cause of Death Affidavit) will be required." },
    { id:'militaryService',      label:"Is any heir, devisee, or surviving spouse in active military service?", showWhen:()=>true,
      warningIfYes:"MPC 470 (Military Affidavit) will be required unless all interested persons assent." },
    { id:'allAssent',            label:"Is it expected that all interested persons will sign an Assent and Waiver of Notice (MPC 455)?", showWhen:()=>true,
      warningIfYes:"MPC 455 required — prepare Assent and Waiver for all interested persons. MPC 470 Military Affidavit not required if all parties sign." },
    { id:'isAmended',            label:"Is this an amended petition (re-filing of a previously filed petition)?",                         showWhen:()=>true },
    { id:'petitionerRelationships', type:'checkboxGroup', label:"Petitioner's interest in estate:", showWhen:()=>true,
      options:[
        { value:'Personal Representative', label:'Personal Representative' },
        { value:'Heir at Law',             label:'Heir at Law' },
        { value:'Devisee',                 label:'Devisee' },
        { value:'Surviving Spouse',        label:'Surviving Spouse' },
        { value:'Creditor',                label:'Creditor' },
        { value:'Other',                   label:'Other' },
      ] },
    // Informal testate only
    { id:'willOriginalAvailable',label:"Is the original will available, unaltered, with no interlineations or deletions?", showWhen:pt=>pt==='informalTestate',
      forcesFormalOnNo:true,
      warningIfNo:"This answer requires Formal Probate. Switching proceeding type." },
    // Informal proceedings
    { id:'heirsIdentified',      label:"Is the identity and address of every heir and devisee known?",          showWhen:pt=>pt==='informalIntestate'||pt==='informalTestate',
      forcesFormalOnNo:true,
      warningIfNo:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'prHasPriority',        label:"Does the proposed PR have statutory priority or valid renunciation/nomination?", showWhen:pt=>pt==='informalIntestate'||pt==='informalTestate',
      forcesFormalOnNo:true,
      warningIfNo:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'minorOrIncapacitated', label:"Is any heir, devisee, or surviving spouse a minor, incapacitated person, or protected person?", showWhen:pt=>pt==='informalIntestate'||pt==='informalTestate',
      forcesFormalOnYes:true,
      warningIfYes:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'prIsCreditor',         label:"Is the proposed PR a creditor or public administrator?",                showWhen:pt=>pt==='informalIntestate'||pt==='informalTestate',
      forcesFormalOnYes:true,
      warningIfYes:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'registeredLand',       label:"Does the estate include registered land (Land Court)?",                 showWhen:pt=>pt==='informalIntestate'||pt==='informalTestate',
      forcesFormalOnYes:true,
      warningIfYes:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'priorInformalProceeding', label:"Was there a prior informal probate proceeding for this estate?",       showWhen:pt=>pt==='formalIntestate'||pt==='formalTestate' },
    { id:'priorInformalDocketNumber', type:'text', label:"Prior informal proceeding docket number:", placeholder:'Docket No.',
      showWhen:(pt,ta)=>(pt==='formalIntestate'||pt==='formalTestate')&&ta.priorInformalProceeding===true },
    // All proceedings
    { id:'supervisedRequired',   label:"Is supervised administration required or requested?",                   showWhen:()=>true,
      forcesFormalOnYes:true,
      warningIfYes:"This answer requires Formal Probate. Switching proceeding type." },
    { id:'bondWithSureties',     label:"Is a bond with sureties required?",                                     showWhen:pt=>pt!=='voluntary',
      warningIfYes:"MPC 801 (Bond) with sureties will be required. Penal sum must equal the estimated value of personal property." },
    // Testate types
    { id:'suretyWaived',         label:"Does the will waive sureties for the nominated PR?",                   showWhen:pt=>pt==='informalTestate'||pt==='formalTestate'||pt==='lateAndLimited',
      sideEffect: (val, answers) => {
        if (val === true)      answers.bondWithSureties = false;
        else if (val === undefined) delete answers.bondWithSureties;
      } },
    { id:'noAttestationClause',  label:"Does the will lack an attestation clause?",                             showWhen:pt=>pt==='formalTestate'||pt==='lateAndLimited',
      warningIfYes:"MPC 480 (Affidavit of Witness to Will) will be required." },
    // Testate: will execution date
    { id:'willDate', type:'text', label:"Date will was executed (MM/DD/YYYY):",
      showWhen:pt=>pt==='informalTestate'||pt==='formalTestate'||pt==='lateAndLimited' },
    // Testate: does the will allow the nominated PR to nominate a successor?
    { id:'willAllowsNomination', label:"Does the will allow the nominated PR to nominate a successor?",
      showWhen:pt=>pt==='informalTestate'||pt==='formalTestate'||pt==='lateAndLimited',
      warningIfYes:"MPC 455 — NOMINATION action enabled for interested persons (will allows it)." },
    // Late & limited
    { id:'hasWill',              label:"Is there a will to be admitted to probate?",                            showWhen:pt=>pt==='lateAndLimited' },
    // Voluntary only
    { id:'allPersonalProperty',  label:"Is all estate property personal property (no real estate)?",           showWhen:pt=>pt==='voluntary',
      disqualifiesVoluntaryOnNo:true,
      warningIfNo:"This answer disqualifies Voluntary Administration. Switching to Informal — No Will." },
    { id:'under25k',             label:"Does total personal property value (excluding vehicles) equal $25,000 or less?", showWhen:pt=>pt==='voluntary',
      disqualifiesVoluntaryOnNo:true,
      warningIfNo:"This answer disqualifies Voluntary Administration. Switching to Informal — No Will." },
    { id:'thirtyDaysSinceDeath', label:"Has it been at least 30 days since date of death?",                    showWhen:pt=>pt==='voluntary',
      disqualifiesVoluntaryOnNo:true,
      warningIfNo:"This answer disqualifies Voluntary Administration. Switching to Informal — No Will." },
    // County of domicile — shown only when not auto-detected from decedent address
    { id:'maCounty', type:'select', label:"County of decedent's domicile:",
      options:['Barnstable','Berkshire','Bristol','Dukes','Essex','Franklin',
               'Hampden','Hampshire','Middlesex','Nantucket','Norfolk',
               'Plymouth','Suffolk','Worcester'],
      showWhen:(pt, ta) => !ta._maCountyAutoDetected },
  ];

  // --- Form set computation ---

  function evalMaCondition(condKey, toggleAnswers, proceedingType) {
    switch (condKey) {
      case 'domicileMismatch':
        if (toggleAnswers.domicileMatches === false) return true;
        if (toggleAnswers.domicileMatches === true)  return false;
        return null;
      case 'causeOfDeathPending':
        if (toggleAnswers.causeOfDeathPending === true)  return true;
        if (toggleAnswers.causeOfDeathPending === false) return false;
        return null;
      case 'renunciationOrNominationOrWaiver':
        return true;
      case 'postAllowance':
        return null;
      case 'noAttestationClause':
        if (toggleAnswers.noAttestationClause === true)  return true;
        if (toggleAnswers.noAttestationClause === false) return false;
        return null;
      case 'attorneyAppearing':
        return true;
      case 'testate':
        if (proceedingType === 'lateAndLimited') {
          if (toggleAnswers.hasWill === true)  return true;
          if (toggleAnswers.hasWill === false) return false;
          return null;
        }
        return proceedingType.includes('Testate') ? true : false;
      default:
        return null;
    }
  }

  function computeMaFormSet(proceedingType, toggleAnswers) {
    const set = MA_FORM_SETS_CLIENT[proceedingType];
    if (!set) return { required: [], mayBeNeeded: [] };

    const required    = new Set(set.always || []);
    const mayBeNeeded = new Set();

    for (const f of (set.requiredIfAppointingPR || [])) required.add(f);

    if (set.requiredUnlessAllAssent) {
      const allAssent  = toggleAnswers.allAssent  === true;
      const noMilitary = toggleAnswers.militaryService === false;
      if (!allAssent && !noMilitary) {
        for (const f of set.requiredUnlessAllAssent) required.add(f);
      }
    }

    for (const [form, condKey] of Object.entries(set.conditional || {})) {
      const result = evalMaCondition(condKey, toggleAnswers, proceedingType);
      if (result === true)  required.add(form);
      else if (result === null) mayBeNeeded.add(form);
    }

    return {
      required:    [...required],
      mayBeNeeded: [...mayBeNeeded].filter(f => !required.has(f)),
    };
  }

  // Returns the appropriate Formal proceeding type to switch to from a given type.
  // informalIntestate → formalIntestate, informalTestate → formalTestate,
  // voluntary → formalIntestate. Returns null if already formal / late & limited.
  function getForcedFormalType(currentType) {
    if (currentType === 'informalIntestate' || currentType === 'voluntary') return 'formalIntestate';
    if (currentType === 'informalTestate') return 'formalTestate';
    return null;
  }

  // --- Utility ---

  function clearEl(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // --- MA county auto-detect (client-side subset of MA_CITY_TO_COUNTY) ---

  const MA_COUNTY_CLIENT = {
    // Barnstable
    barnstable:'Barnstable',bourne:'Barnstable',brewster:'Barnstable',chatham:'Barnstable',
    dennis:'Barnstable',eastham:'Barnstable',falmouth:'Barnstable',harwich:'Barnstable',
    mashpee:'Barnstable',orleans:'Barnstable',provincetown:'Barnstable',sandwich:'Barnstable',
    truro:'Barnstable',wellfleet:'Barnstable',yarmouth:'Barnstable',
    // Berkshire
    adams:'Berkshire',pittsfield:'Berkshire','north adams':'Berkshire','great barrington':'Berkshire',
    lenox:'Berkshire',lee:'Berkshire',dalton:'Berkshire',stockbridge:'Berkshire',
    // Bristol
    taunton:'Bristol',attleboro:'Bristol','fall river':'Bristol','new bedford':'Bristol',
    brockton:'Bristol',dartmouth:'Bristol',easton:'Bristol',mansfield:'Bristol',
    'north attleborough':'Bristol','north attleboro':'Bristol',norton:'Bristol',
    raynham:'Bristol',rehoboth:'Bristol',seekonk:'Bristol',somerset:'Bristol',
    swansea:'Bristol',westport:'Bristol',fairhaven:'Bristol',acushnet:'Bristol',
    // Dukes
    edgartown:'Dukes','oak bluffs':'Dukes',tisbury:'Dukes',chilmark:'Dukes',aquinnah:'Dukes','west tisbury':'Dukes',
    // Essex
    lynn:'Essex',salem:'Essex',haverhill:'Essex',lawrence:'Essex',peabody:'Essex',
    beverly:'Essex',gloucester:'Essex',andover:'Essex',danvers:'Essex',
    'north andover':'Essex',amesbury:'Essex',ipswich:'Essex',newburyport:'Essex',
    marblehead:'Essex',saugus:'Essex',swampscott:'Essex',methuen:'Essex',
    // Franklin
    greenfield:'Franklin',orange:'Franklin',deerfield:'Franklin',montague:'Franklin',
    // Hampden
    springfield:'Hampden',chicopee:'Hampden',holyoke:'Hampden',westfield:'Hampden',
    agawam:'Hampden','west springfield':'Hampden',ludlow:'Hampden',
    longmeadow:'Hampden','east longmeadow':'Hampden',wilbraham:'Hampden',
    // Hampshire
    northampton:'Hampshire',amherst:'Hampshire','south hadley':'Hampshire',
    easthampton:'Hampshire',ware:'Hampshire',hadley:'Hampshire',belchertown:'Hampshire',
    // Middlesex
    lowell:'Middlesex',cambridge:'Middlesex',somerville:'Middlesex',
    everett:'Middlesex',malden:'Middlesex',medford:'Middlesex',newton:'Middlesex',
    waltham:'Middlesex',watertown:'Middlesex',woburn:'Middlesex',
    framingham:'Middlesex',marlborough:'Middlesex',billerica:'Middlesex',
    chelmsford:'Middlesex',dracut:'Middlesex',tewksbury:'Middlesex',
    wilmington:'Middlesex',burlington:'Middlesex',lexington:'Middlesex',
    arlington:'Middlesex',belmont:'Middlesex',natick:'Middlesex',
    acton:'Middlesex',concord:'Middlesex',bedford:'Middlesex',
    wakefield:'Middlesex',reading:'Middlesex','north reading':'Middlesex',
    // Nantucket
    nantucket:'Nantucket',
    // Norfolk
    quincy:'Norfolk',braintree:'Norfolk',weymouth:'Norfolk',milton:'Norfolk',
    needham:'Norfolk',dedham:'Norfolk',norwood:'Norfolk',canton:'Norfolk',
    stoughton:'Norfolk',randolph:'Norfolk',brookline:'Norfolk',wellesley:'Norfolk',
    westwood:'Norfolk',walpole:'Norfolk',sharon:'Norfolk',franklin:'Norfolk',
    foxborough:'Norfolk',foxboro:'Norfolk',wrentham:'Norfolk',plainville:'Norfolk',
    // Plymouth
    plymouth:'Plymouth',brockton:'Plymouth',hingham:'Plymouth',marshfield:'Plymouth',
    duxbury:'Plymouth',scituate:'Plymouth',hanover:'Plymouth',pembroke:'Plymouth',
    kingston:'Plymouth',wareham:'Plymouth',middleborough:'Plymouth',
    rockland:'Plymouth',abington:'Plymouth','east bridgewater':'Plymouth',
    bridgewater:'Plymouth','west bridgewater':'Plymouth',whitman:'Plymouth',
    // Suffolk
    boston:'Suffolk',chelsea:'Suffolk',revere:'Suffolk',winthrop:'Suffolk',
    // Worcester
    worcester:'Worcester',fitchburg:'Worcester',leominster:'Worcester',
    gardner:'Worcester',shrewsbury:'Worcester',auburn:'Worcester',
    milford:'Worcester',northborough:'Worcester',westborough:'Worcester',
    southborough:'Worcester',grafton:'Worcester',oxford:'Worcester',
    webster:'Worcester',dudley:'Worcester',southbridge:'Worcester',
    spencer:'Worcester',clinton:'Worcester',marlborough:'Middlesex',
  };

  function detectMaCounty(domicile) {
    if (!domicile) return null;
    const parts = domicile.split(',');
    const city  = (parts[0] || '').trim().toLowerCase();
    const state = (parts[1] || '').trim().toUpperCase();
    if (state !== 'MA' && state !== 'MASSACHUSETTS') return null;
    return MA_COUNTY_CLIENT[city] || null;
  }

  // --- Main MA UI builder ---

  function buildMaUI(matterId, matter, allContacts, container, suggestedProceedingType = null) {
    const maState = {
      proceedingType:     suggestedProceedingType || 'informalIntestate',
      toggleAnswers:      { petitionerRelationships: ['Personal Representative'] },
      analysisData:       null,
      forcedSwitchBanner: null,
    };

    // Placeholder sections (rebuilt in-place on state changes)
    const ptDiv        = el('div', {});
    const autoPanelDiv = el('div', {});
    const toggleDiv    = el('div', {});
    const partiesDiv   = el('div', {});
    const mpc455Div    = el('div', {});
    const formSetDiv   = el('div', {});
    const genBtnDiv    = el('div', {});
    const indivDiv     = el('div', {});
    const closingDiv   = el('div', {});

    container.appendChild(ptDiv);
    container.appendChild(autoPanelDiv);
    container.appendChild(toggleDiv);
    container.appendChild(partiesDiv);
    container.appendChild(mpc455Div);
    container.appendChild(formSetDiv);
    container.appendChild(genBtnDiv);
    container.appendChild(indivDiv);
    container.appendChild(closingDiv);

    // -- Proceeding type toggle --
    function renderProceedingToggle() {
      clearEl(ptDiv);
      const radioName = `ma-pt-${matterId}`;
      const wrap = el('div', { className: 'petition-toggle', style: 'flex-wrap:wrap' });
      for (const pt of MA_PROC_TYPES) {
        const input = document.createElement('input');
        input.type  = 'radio';
        input.name  = radioName;
        input.value = pt.id;
        input.checked = pt.id === maState.proceedingType;
        input.addEventListener('change', () => {
          if (input.checked) {
            maState.proceedingType = pt.id;
            maState.forcedSwitchBanner = null; // clear when user manually picks a type
            maState.toggleAnswers.mpc455Config = null; // reset 455 defaults on type change
            renderProceedingToggle();
            renderTogglePanel();
            renderMPC455Panel();
            renderFormSet();
            renderIndivForms();
          }
        });
        const lbl = el('label', {}, input, el('span', {}, pt.label));
        wrap.appendChild(lbl);
      }
      ptDiv.appendChild(wrap);

      // Forced-switch banner (set when a toggle auto-switched the proceeding type)
      if (maState.forcedSwitchBanner) {
        ptDiv.appendChild(
          el('div', { className: 'warning-banner', style: 'margin: 0.4rem 0 0' },
            el('span', { className: 'warning-banner-text' }, '⚠ ' + maState.forcedSwitchBanner.message)
          )
        );
      }

      // Persistent Late & Limited restriction notice
      if (maState.proceedingType === 'lateAndLimited') {
        ptDiv.appendChild(
          el('div', { className: 'warning-banner', style: 'margin: 0.4rem 0 0' },
            'Note: PR authority under Late & Limited is restricted — may only confirm title in successors and pay administration expenses. Cannot seek license to sell real estate. Letters of Authority must note this limitation.'
          )
        );
      }
    }

    // -- Auto-populated data panel --
    function renderAutoPanel() {
      clearEl(autoPanelDiv);
      const data = maState.analysisData;
      if (!data) return;
      const md = data.matterData;

      // Try to auto-detect MA county from decedent's domicile
      const autoCounty = detectMaCounty(md.domicile);
      if (autoCounty) {
        maState.toggleAnswers._maCountyAutoDetected = true;
        if (!maState.toggleAnswers.maCounty) maState.toggleAnswers.maCounty = autoCounty;
      } else {
        maState.toggleAnswers._maCountyAutoDetected = false;
      }

      const rows = [
        ['Decedent',              md.decedentName],
        ['Date of Death',         md.dateOfDeath ? new Date(md.dateOfDeath + 'T00:00:00').toLocaleDateString('en-US') : null],
        ['Days Since Death',      md.daysSinceDeath !== null ? String(md.daysSinceDeath) : null],
        ['Domicile',              md.domicile],
        ['County',                autoCounty],
        ['Total Estate Value',    md.totalEstateValue ? '$' + md.totalEstateValue : null],
        ['Real Estate Detected',  md.hasRealEstate !== undefined ? (md.hasRealEstate ? 'Yes' : 'No (not detected)') : null],
        ['Personal Property ~',   md.totalPersonalPropertyValue != null ? '$' + md.totalPersonalPropertyValue.toLocaleString('en-US', { maximumFractionDigits: 0 }) : null],
        ['Voluntary Admin',       md.voluntaryEligible !== undefined ? (md.voluntaryEligible ? 'Appears eligible' : 'Not eligible') : null],
      ].filter(([, v]) => v !== null && v !== undefined);

      if (rows.length === 0) return;

      const panel = el('div', { className: 'ma-auto-panel' });
      for (const [label, value] of rows) {
        panel.appendChild(
          el('div', { className: 'dv-row' },
            el('span', { className: 'dv-label' }, label),
            el('span', { className: 'dv-value' },
              value,
              el('span', { className: 'dv-badge' }, 'From DecisionVault')
            )
          )
        );
      }

      if (md.voluntaryEligibilityIssues?.length > 0) {
        for (const issue of md.voluntaryEligibilityIssues) {
          panel.appendChild(
            el('div', { className: 'warning-banner', style: 'margin: 0.35rem 0 0' }, issue)
          );
        }
      }

      autoPanelDiv.appendChild(panel);

      if (data.heirs?.warnings?.length > 0) {
        for (const w of data.heirs.warnings) {
          autoPanelDiv.appendChild(
            el('div', { className: 'warning-banner', style: 'margin:0.35rem 0 0' }, w)
          );
        }
      }
    }

    // -- Toggle questions panel --
    function renderTogglePanel() {
      clearEl(toggleDiv);
      const visible = MA_TOGGLE_DEFS.filter(t => t.showWhen(maState.proceedingType, maState.toggleAnswers));
      if (visible.length === 0) return;

      const section = el('div', { className: 'ma-toggle-section' });
      section.appendChild(el('div', { className: 'ma-toggle-section-header' }, 'Case Facts'));

      for (const toggle of visible) {
        // Checkbox group fields
        if (toggle.type === 'checkboxGroup') {
          const current = maState.toggleAnswers[toggle.id] || [];
          const group = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 12px' });
          for (const opt of toggle.options) {
            const cbId = `cg-${toggle.id}-${opt.value.replace(/\s+/g, '-')}`;
            const cb = el('input', { type: 'checkbox', id: cbId });
            cb.checked = current.includes(opt.value);
            cb.addEventListener('change', () => {
              if (!Array.isArray(maState.toggleAnswers[toggle.id])) {
                maState.toggleAnswers[toggle.id] = [];
              }
              const arr = maState.toggleAnswers[toggle.id];
              if (cb.checked) {
                if (!arr.includes(opt.value)) arr.push(opt.value);
              } else {
                const idx = arr.indexOf(opt.value);
                if (idx !== -1) arr.splice(idx, 1);
              }
            });
            group.appendChild(el('label', { for: cbId, style: 'display:flex;align-items:center;gap:4px;cursor:pointer' },
              cb, el('span', {}, opt.label)
            ));
          }
          section.appendChild(el('div', { className: 'ma-toggle-row' },
            el('span', { className: 'toggle-label' }, toggle.label), group
          ));
          continue;
        }

        // Dropdown select fields
        if (toggle.type === 'select') {
          const sel = document.createElement('select');
          sel.style.cssText = 'font-size:0.82rem;padding:2px 6px;border:1px solid #d1d5db;border-radius:4px;';
          const blank = document.createElement('option');
          blank.value = ''; blank.textContent = '— select —';
          sel.appendChild(blank);
          for (const opt of toggle.options) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (maState.toggleAnswers[toggle.id] === opt) o.selected = true;
            sel.appendChild(o);
          }
          sel.addEventListener('change', () => {
            maState.toggleAnswers[toggle.id] = sel.value || undefined;
            renderTogglePanel();
          });
          section.appendChild(
            el('div', { className: 'ma-toggle-row' },
              el('span', { className: 'toggle-label' }, toggle.label),
              sel
            )
          );
          continue;
        }

        // Text input fields (not YES/NO toggles)
        if (toggle.type === 'text') {
          const input = el('input', {
            type: 'text',
            placeholder: toggle.placeholder || 'MM/DD/YYYY',
            value: maState.toggleAnswers[toggle.id] || '',
            className: 'toggle-text-input',
          });
          input.addEventListener('input', () => {
            maState.toggleAnswers[toggle.id] = input.value.trim();
          });
          section.appendChild(
            el('div', { className: 'ma-toggle-row' },
              el('span', { className: 'toggle-label' }, toggle.label),
              input
            )
          );
          continue;
        }

        const answer = maState.toggleAnswers[toggle.id]; // true | false | undefined

        const yesBtn = el('button', { className: 'pill-btn' + (answer === true  ? ' yes-active' : '') }, 'YES');
        const noBtn  = el('button', { className: 'pill-btn' + (answer === false ? ' no-active'  : '') }, 'NO');

        function applyToggle(newVal) {
          // If this is the toggle that set the current banner, clear it first —
          // the user is changing their answer so the previous switch reason is stale.
          if (maState.forcedSwitchBanner?.triggeredByToggleId === toggle.id) {
            maState.forcedSwitchBanner = null;
          }

          maState.toggleAnswers[toggle.id] = newVal;
          if (toggle.sideEffect) toggle.sideEffect(newVal, maState.toggleAnswers);

          function setBanner(targetProceedingType, answerText) {
            const ptLabel = MA_PROC_TYPES.find(p => p.id === targetProceedingType)?.label || targetProceedingType;
            maState.forcedSwitchBanner = {
              message: `Switched to ${ptLabel} because: '${toggle.label}' was answered ${answerText}.`,
              triggeredByToggleId: toggle.id,
            };
          }

          // Auto-switch proceeding type when required
          if (newVal === true && toggle.forcesFormalOnYes) {
            const forced = getForcedFormalType(maState.proceedingType);
            if (forced && forced !== maState.proceedingType) {
              maState.proceedingType = forced;
              setBanner(forced, 'YES');
            }
          }
          if (newVal === false && toggle.forcesFormalOnNo) {
            const forced = getForcedFormalType(maState.proceedingType);
            if (forced && forced !== maState.proceedingType) {
              maState.proceedingType = forced;
              setBanner(forced, 'NO');
            }
          }
          if (newVal === false && toggle.disqualifiesVoluntaryOnNo) {
            if (maState.proceedingType === 'voluntary') {
              maState.proceedingType = 'informalIntestate';
              setBanner('informalIntestate', 'NO');
            }
          }

          renderProceedingToggle();
          renderTogglePanel();
          renderMPC455Panel();
          renderFormSet();
          renderIndivForms();
        }

        yesBtn.addEventListener('click', () => {
          applyToggle(answer === true ? undefined : true);
        });
        noBtn.addEventListener('click', () => {
          applyToggle(answer === false ? undefined : false);
        });

        section.appendChild(
          el('div', { className: 'ma-toggle-row' },
            el('span', { className: 'toggle-label' }, toggle.label),
            el('div', { className: 'pill-group' }, yesBtn, noBtn)
          )
        );

        // Warning banner
        let warningMsg = null;
        if (toggle.warningIfYes && answer === true)  warningMsg = toggle.warningIfYes;
        if (toggle.warningIfNo  && answer === false) warningMsg = toggle.warningIfNo;
        if (warningMsg) {
          section.appendChild(
            el('div', { className: 'warning-banner' },
              el('span', { className: 'warning-banner-text' }, '⚠ ' + warningMsg)
            )
          );
        }
      }

      toggleDiv.appendChild(section);
    }

    // -- Interested parties panel --
    function renderInterestedParties() {
      clearEl(partiesDiv);
      const data = maState.analysisData;
      const annotated = data?.heirs?.annotatedContacts
        || allContacts
             .filter(c => !['1MAIN','5ATTO','5CFP','5CPA','5OTHE','5PCP','5REAL','5WMAN','4CONT','1DIVO'].includes(c.relationship?.type))
             .map(c => ({ ...c, maRoles: [], maFlags: [] }));

      if (annotated.length === 0) return;

      const details = document.createElement('details');
      details.className = 'beneficiary-panel';
      details.setAttribute('open', '');
      const summary = document.createElement('summary');
      summary.textContent = 'Interested Parties';
      details.appendChild(summary);

      const listDiv = el('div', { className: 'beneficiary-list' });

      for (const contact of annotated) {
        const roles  = contact.maRoles || [];
        const flags  = contact.maFlags || [];
        const isHeirOrSpouse = roles.includes('LEGAL_HEIR') || roles.includes('SURVIVING_SPOUSE');
        const itemId = `ma-party-${matterId}-${contact.id}`;

        const checkbox = el('input', { type: 'checkbox', id: itemId });
        if (isHeirOrSpouse) checkbox.setAttribute('checked', '');

        const labelNode = document.createElement('label');
        labelNode.setAttribute('for', itemId);
        labelNode.appendChild(document.createTextNode(contact.full_name));

        const relText = contact.relationship?.short ?? '';
        if (relText) {
          labelNode.appendChild(el('span', { className: 'rel-badge' }, ` (${relText})`));
        }

        for (const role of roles) {
          if (role === 'LEGAL_HEIR') {
            labelNode.appendChild(document.createTextNode(' '));
            labelNode.appendChild(el('span', { className: 'ma-badge heir' }, 'Legal Heir'));
          } else if (role === 'SURVIVING_SPOUSE') {
            labelNode.appendChild(document.createTextNode(' '));
            labelNode.appendChild(el('span', { className: 'ma-badge spouse' }, 'Surviving Spouse'));
          } else if (role === 'CHILD_NOT_HEIR') {
            labelNode.appendChild(document.createTextNode(' '));
            labelNode.appendChild(el('span', { className: 'ma-badge stepchild' }, 'Stepchild'));
          }
        }
        for (const flag of flags) {
          if (flag === 'MINOR') {
            labelNode.appendChild(document.createTextNode(' '));
            labelNode.appendChild(el('span', { className: 'ma-badge minor' }, 'Minor'));
          }
        }

        listDiv.appendChild(
          el('div', { className: 'beneficiary-item' + (isHeirOrSpouse ? ' is-heir' : '') },
            checkbox, labelNode
          )
        );
      }

      details.appendChild(listDiv);
      partiesDiv.appendChild(details);
    }

    // -- MPC 455 per-person panel --
    function computeMpc455Defaults(annotated) {
      const pt = maState.proceedingType;
      const ta = maState.toggleAnswers;
      const hasWill = pt.includes('Testate') || ta.hasWill === true;
      const canNominate = !hasWill || ta.willAllowsNomination === true;
      const bondWithSureties = !!ta.bondWithSureties;
      const suretyWaived = !!ta.suretyWaived;
      const defaultWaiverOfSureties = !bondWithSureties || suretyWaived;
      // If a non-PR surviving spouse exists, the PR is a child/heir (P5); otherwise assume P4.
      const hasNonPRSpouse = annotated.some(c =>
        (c.maRoles || []).includes('SURVIVING_SPOUSE') &&
        !c.is_client && c.relationship?.type !== '0CLNT'
      );
      const prPriority = hasWill ? 1 : (hasNonPRSpouse ? 5 : 4);

      const pr = annotated.find(c => (c.maRoles || []).includes('PETITIONER') || c.relationship?.type === '0CLNT');
      const prName = pr ? { first: pr.first_name || '', last: pr.last_name || '', mi: pr.middle_name || '' } : null;

      const CAPACITY_MAP = {
        '1MARR':'Surviving Spouse','1WIDW':'Surviving Spouse','3LIFP':'Domestic Partner',
        '2SON':'Heir/Child','2DATR':'Heir/Child','2ADOP':'Heir/Child','2ADTD':'Heir/Child',
        '3GSON':'Heir/Grandchild','3GDTR':'Heir/Grandchild',
        '3FATH':'Heir/Parent','3MOTH':'Heir/Parent',
        '3BROT':'Heir/Sibling','3SIST':'Heir/Sibling','3SIBL':'Heir/Sibling',
        '3AUNT':'Heir/Aunt','3UCLE':'Heir/Uncle','3NIEC':'Heir/Niece','3NEPW':'Heir/Nephew','3COUS':'Heir/Cousin',
        '3OTHE':'Other Relative','4FRIE':'Friend/Interested Party',
        '2SDTR':'Stepchild','2SSON':'Stepchild',
      };

      function pClass(c) {
        const roles = c.maRoles || [];
        if (hasWill) {
          if (roles.includes('SURVIVING_SPOUSE')) return 2;
          if (roles.includes('LEGAL_HEIR'))       return 3;
          return 4;
        } else {
          if (roles.includes('SURVIVING_SPOUSE')) return 4;
          if (roles.includes('LEGAL_HEIR'))       return 5;
          return 6;
        }
      }

      const SKIP_REL = new Set(['1MAIN','1DIVO','5ATTO','5CFP','5CPA','5OTHE','5PCP','5REAL','5WMAN','4CONT']);
      return annotated
        .filter(c => {
          if (SKIP_REL.has(c.relationship?.type)) return false;
          if (c.is_client || c.relationship?.type === '0CLNT') return false;
          return true;
        })
        .map(c => {
          const pc = pClass(c);
          const renunciation = pc <= prPriority;
          const nomination = renunciation && canNominate && !!prName;
          return {
            id: c.id,
            firstName: c.first_name || '',
            lastName:  c.last_name  || '',
            middleName: c.middle_name || '',
            capacityLabel: CAPACITY_MAP[c.relationship?.type] || (c.relationship?.short || 'Interested Party'),
            priorityClass: pc,
            assent: true,
            waiverOfNotice: true,
            renunciation,
            nomination,
            consentToNomination: false,
            waiverOfSureties: defaultWaiverOfSureties,
            nomineeName: prName ? { ...prName } : { first:'', last:'', mi:'' },
            canNominate,
          };
        });
    }

    function renderMPC455Panel() {
      clearEl(mpc455Div);
      const data = maState.analysisData;
      const annotated = data?.heirs?.annotatedContacts
        || allContacts
             .filter(c => !['1MAIN','5ATTO','5CFP','5CPA','5OTHE','5PCP','5REAL','5WMAN','4CONT','1DIVO'].includes(c.relationship?.type))
             .map(c => ({ ...c, maRoles: [], maFlags: [] }));

      // Pre-populate config if not yet set or stale (different count)
      const defaults = computeMpc455Defaults(annotated);
      if (!Array.isArray(maState.toggleAnswers.mpc455Config) ||
          maState.toggleAnswers.mpc455Config.length !== defaults.length) {
        maState.toggleAnswers.mpc455Config = defaults.map(d => ({ ...d }));
      }

      const config = maState.toggleAnswers.mpc455Config;
      if (config.length === 0) return;

      const details = document.createElement('details');
      details.className = 'beneficiary-panel';
      details.setAttribute('open', '');
      const summary = document.createElement('summary');
      summary.textContent = 'MPC 455 — Assent & Waiver Preparation';
      details.appendChild(summary);

      const note = el('p', {
        style: 'margin:0.35rem 0.85rem 0.5rem;font-size:0.8rem;color:#374151;font-style:italic'
      }, 'A separate MPC 455 will be prepared for each person listed below. Defaults are pre-populated per § 3-203 priority; adjust as needed.');
      details.appendChild(note);

      const ACTION_KEYS = ['assent','waiverOfNotice','renunciation','nomination','waiverOfSureties'];
      const ACTION_LABELS = {
        assent: 'ASSENT', waiverOfNotice: 'WAIVER OF NOTICE',
        renunciation: 'RENUNCIATION', nomination: 'NOMINATION', waiverOfSureties: 'WAIVER OF SURETIES',
      };

      const listDiv = el('div', { className: 'beneficiary-list', style: 'padding:0' });

      for (let i = 0; i < config.length; i++) {
        const cfg = config[i];

        // Name and badge row
        const nameLabel = el('span', { style: 'font-weight:500' },
          `${cfg.firstName} ${cfg.lastName}`.trim() || cfg.id
        );
        const capBadge = el('span', { className: 'rel-badge' }, ` (${cfg.capacityLabel})`);
        const priLabel = el('span', {
          style: 'margin-left:6px;font-size:0.72rem;color:#6b7280;font-style:italic'
        }, `P${cfg.priorityClass}`);

        const nameRow = el('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:6px' },
          nameLabel, capBadge, priLabel
        );

        // Action toggle buttons
        const actionRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 6px' });

        for (const key of ACTION_KEYS) {
          const isOn = !!cfg[key];
          const btnClass = `pill-btn${isOn ? ' yes-active' : ''}`;
          const btn = el('button', { className: btnClass, style: 'font-size:0.72rem;padding:2px 9px' },
            ACTION_LABELS[key]
          );

          if (key === 'nomination' && !cfg.canNominate) {
            btn.title = 'Will does not allow nomination — enable "willAllowsNomination" toggle above';
            btn.style.opacity = '0.5';
          }

          btn.addEventListener('click', () => {
            config[i][key] = !config[i][key];
            // If nomination was just turned ON but canNominate is false, revert
            if (key === 'nomination' && config[i][key] && !cfg.canNominate) {
              config[i][key] = false;
              return;
            }
            renderMPC455Panel();
          });
          actionRow.appendChild(btn);
        }

        // Nominee name input — shown when nomination is ON
        let nomineeRow = null;
        if (cfg.nomination) {
          const fIn = el('input', { type:'text', placeholder:'First', value: cfg.nomineeName?.first || '',
            style:'width:90px;font-size:0.8rem;padding:2px 5px;border:1px solid #d1d5db;border-radius:3px' });
          const mIn = el('input', { type:'text', placeholder:'MI', value: cfg.nomineeName?.mi || '',
            style:'width:35px;font-size:0.8rem;padding:2px 5px;border:1px solid #d1d5db;border-radius:3px' });
          const lIn = el('input', { type:'text', placeholder:'Last', value: cfg.nomineeName?.last || '',
            style:'width:90px;font-size:0.8rem;padding:2px 5px;border:1px solid #d1d5db;border-radius:3px' });

          function syncNominee() {
            config[i].nomineeName = { first: fIn.value, mi: mIn.value, last: lIn.value };
          }
          fIn.addEventListener('input', syncNominee);
          mIn.addEventListener('input', syncNominee);
          lIn.addEventListener('input', syncNominee);

          nomineeRow = el('div', { style: 'display:flex;align-items:center;gap:4px;margin-top:5px;flex-wrap:wrap' },
            el('span', { style: 'font-size:0.75rem;color:#6b7280' }, 'Nominee:'),
            fIn, mIn, lIn
          );
        }

        const itemDiv = el('div', {
          className: 'beneficiary-item',
          style: 'flex-direction:column;align-items:flex-start;padding:8px 10px',
        }, nameRow, actionRow);
        if (nomineeRow) itemDiv.appendChild(nomineeRow);

        listDiv.appendChild(itemDiv);
      }

      details.appendChild(listDiv);
      mpc455Div.appendChild(details);
    }

    // Split "MPC 150 — Petition for ..." into ['MPC 150', 'Petition for ...']
    function splitFormLabel(label) {
      const idx = label.indexOf(' — ');
      if (idx === -1) return [label, ''];
      return [label.slice(0, idx), label.slice(idx + 3)];
    }

    // Build a two-line chip element
    function makeChip(className, label) {
      const [num, name] = splitFormLabel(label);
      const chip = el('span', { className });
      chip.appendChild(el('span', { className: 'form-chip-number' }, num));
      if (name) chip.appendChild(el('span', { className: 'form-chip-name' }, name));
      return chip;
    }

    // -- Form set display --
    function renderFormSet() {
      clearEl(formSetDiv);
      const { required, mayBeNeeded } = computeMaFormSet(maState.proceedingType, maState.toggleAnswers);
      const set = MA_FORM_SETS_CLIENT[maState.proceedingType];

      const section = el('div', { className: 'form-set-section' });

      if (set?.fee) {
        section.appendChild(
          el('div', { className: 'ma-fee' }, 'Filing Fee: ', el('strong', {}, '$' + set.fee))
        );
      }

      if (set?.warning) {
        section.appendChild(el('div', { className: 'late-limited-warning' }, set.warning));
      }

      section.appendChild(el('div', { className: 'form-set-label' }, 'Required Forms'));
      const reqChips = el('div', { className: 'form-chips' });
      if (required.length === 0) {
        reqChips.appendChild(el('span', { className: 'form-chip empty' }, 'None determined'));
      } else {
        for (const f of required) {
          let chipLabel = MA_FORM_FULL_LABELS[f] || f;
          if (f === 'MPC-801') {
            const ta = maState.toggleAnswers;
            if (ta.suretyWaived === true)          chipLabel = 'MPC 801 — Bond (No Sureties — Waived by Will)';
            else if (ta.bondWithSureties === false) chipLabel = 'MPC 801 — Bond (No Sureties)';
            else                                   chipLabel = 'MPC 801 — Bond (With Sureties)';
          }
          const chipClass = COURT_ISSUED_FORMS.has(f) ? 'form-chip court-issued' : 'form-chip required';
          reqChips.appendChild(makeChip(chipClass, chipLabel));
        }
      }
      section.appendChild(reqChips);

      if (required.includes('MPC-801')) {
        const bondNote = el('p', { style: 'font-size:0.78rem;color:#6b7280;margin:0.25rem 0 0.5rem;line-height:1.4' },
          'Bond required before Letters of Authority will issue. Penal sum must equal personal property value unless sureties waived.'
        );
        section.appendChild(bondNote);
      }

      if (mayBeNeeded.length > 0) {
        const mayLabel = el('div', { className: 'form-set-label' }, 'May Be Needed');
        mayLabel.style.marginTop = '0.5rem';
        section.appendChild(mayLabel);
        const condChips = el('div', { className: 'form-chips' });
        for (const f of mayBeNeeded) {
          condChips.appendChild(makeChip('form-chip conditional', MA_FORM_FULL_LABELS[f] || f));
        }
        section.appendChild(condChips);
      }

      // DMA notice (all proceedings except voluntary)
      const dmaMsg = {
        informalIntestate: 'Remember: DMA notice must be sent by certified mail at least 7 days before filing. Include a copy of the signed petition and death certificate.',
        informalTestate:   'Remember: DMA notice must be sent by certified mail at least 7 days before filing. Include a copy of the signed petition and death certificate.',
        formalIntestate:   'Remember: DMA notice must be sent with a copy of the citation and signed petition by certified mail at least 14 days before the return date.',
        formalTestate:     'Remember: DMA notice must be sent with a copy of the citation and signed petition by certified mail at least 14 days before the return date.',
        lateAndLimited:    'Remember: DMA notice must be sent with a copy of the citation and signed petition by certified mail at least 14 days before the return date.',
      }[maState.proceedingType];
      if (dmaMsg) {
        section.appendChild(el('div', { className: 'ma-dma-notice' }, dmaMsg));
      }

      formSetDiv.appendChild(section);
    }

    // -- Generate Full Package button --
    function renderGenBtn() {
      clearEl(genBtnDiv);

      const btn    = el('button', { className: 'package-btn' }, '📄 Generate Full Package');
      const errBanner = el('div', {
        style: 'display:none;margin-top:0.5rem;padding:0.45rem 0.65rem;background:#fef2f2;' +
               'border:1px solid #fca5a5;border-radius:4px;color:#b91c1c;font-size:0.82rem',
      });

      btn.addEventListener('click', () => {
        const set       = MA_FORM_SETS_CLIENT[maState.proceedingType];
        const decName   = safeFilePart(maState.analysisData?.matterData?.decedentName || 'estate');
        const procLabel = safeFilePart(set?.label || maState.proceedingType);
        const filename  = `MA-${procLabel}-Package_${decName}-${todayStamp()}.pdf`;

        postAndDownload(
          btn,
          `/api/ma/matter/${matterId}/generate-package`,
          {
            proceedingType:  maState.proceedingType,
            toggleAnswers:   maState.toggleAnswers,
            excludeForms:    [...COURT_ISSUED_FORMS],
          },
          filename,
          errBanner
        );
      });

      genBtnDiv.appendChild(btn);
      genBtnDiv.appendChild(errBanner);
    }

    // -- Individual forms collapsible --
    function renderIndivForms() {
      clearEl(indivDiv);
      const set = MA_FORM_SETS_CLIENT[maState.proceedingType];
      if (!set) return;

      const allFormsForType = [...new Set([
        ...(set.always || []),
        ...(set.requiredIfAppointingPR || []),
        ...(set.requiredUnlessAllAssent || []),
        ...Object.keys(set.conditional || {}),
      ])];

      const { required } = computeMaFormSet(maState.proceedingType, maState.toggleAnswers);
      const reqSet = new Set(required);

      const details = document.createElement('details');
      details.className = 'individual-forms';
      const summary = document.createElement('summary');
      summary.textContent = 'Individual Forms';
      details.appendChild(summary);

      const btnList = el('div', { className: 'form-btn-list' });

      for (const formId of allFormsForType) {
        const fullLabel  = MA_FORM_FULL_LABELS[formId] || formId;
        const isRequired = reqSet.has(formId);
        const isCourtIssued = COURT_ISSUED_FORMS.has(formId);
        const btnClass   = 'form-btn' + (isRequired ? '' : ' on-request');

        const [num, name] = splitFormLabel(fullLabel);
        const btn = el('button', {
          className: btnClass,
          style:     'flex-direction:column;align-items:flex-start',
          title:     isCourtIssued ? 'Court-issued — generated by the court upon filing' : '',
        });
        btn.appendChild(el('span', { className: 'form-chip-number' }, num));
        if (name) {
          const nameSuffix = isCourtIssued ? name + ' (court-issued)' : (!isRequired ? name + ' — conditional' : name);
          btn.appendChild(el('span', { className: 'form-chip-name' }, nameSuffix));
        }

        if (isCourtIssued) {
          btn.disabled = true;
          btn.title = 'Court-issued — generated by the court upon filing, not pre-filled here';
        } else {
          btn.addEventListener('click', () => {
            const decName  = safeFilePart(maState.analysisData?.matterData?.decedentName || 'estate');
            const filename = `${formId}_${decName}-${todayStamp()}.pdf`;
            postAndDownload(
              btn,
              `/api/ma/matter/${matterId}/generate-form`,
              { formId, toggleAnswers: maState.toggleAnswers },
              filename,
              null
            );
          });
        }

        btnList.appendChild(btn);
      }

      details.appendChild(btnList);
      indivDiv.appendChild(details);
    }

    // -- Estate closing & accounting forms (static — not part of initial filing) --
    const MA_CLOSING_FORMS_CLIENT = [
      { formId: 'MPC-854', label: 'MPC 854 — Inventory' },
      { formId: 'MPC-850', label: 'MPC 850 — Closing Statement' },
      { formId: 'MPC-851', label: 'MPC 851 — Small Estate Closing Statement' },
      { formId: 'MPC-853', label: 'MPC 853 — Account' },
      { formId: 'MPC-855', label: 'MPC 855 — Petition for Order of Complete Settlement' },
      { formId: 'MPC-857', label: 'MPC 857 — Petition for Allowance of Account' },
    ];

    function renderClosingForms() {
      const details = document.createElement('details');
      details.className = 'individual-forms';
      details.style.borderLeft = '3px solid #d97706';

      const summary = document.createElement('summary');
      summary.style.color = '#92400e';
      summary.textContent = 'Estate Closing & Accounting Forms';
      details.appendChild(summary);

      const header = el('div', { style: 'padding:0.5rem 0.85rem 0' });
      const subtitle = el('p', { style: 'margin:0 0 0.4rem;font-size:0.8rem;color:#6b7280;font-style:italic' },
        'These forms are used during administration and closing — not part of the initial filing.'
      );
      const note = el('p', { style: 'margin:0;font-size:0.78rem;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:4px;padding:0.45rem 0.6rem;line-height:1.45' },
        'Inventory (MPC 854) must be filed within 3 months of appointment. Accounts and closing statements require court approval and follow after the creditor claim period (1 year from death) has expired.'
      );
      header.appendChild(subtitle);
      header.appendChild(note);
      details.appendChild(header);

      const btnList = el('div', { className: 'form-btn-list' });
      for (const { formId, label } of MA_CLOSING_FORMS_CLIENT) {
        const [num, name] = splitFormLabel(label);
        const btn = el('button', { className: 'form-btn', style: 'flex-direction:column;align-items:flex-start' });
        btn.appendChild(el('span', { className: 'form-chip-number' }, num));
        if (name) btn.appendChild(el('span', { className: 'form-chip-name' }, name));

        btn.addEventListener('click', () => {
          const decName  = safeFilePart(maState.analysisData?.matterData?.decedentName || 'estate');
          const filename = `${formId}_${decName}-${todayStamp()}.pdf`;
          postAndDownload(
            btn,
            `/api/ma/matter/${matterId}/generate-form`,
            { formId, toggleAnswers: maState.toggleAnswers },
            filename,
            null
          );
        });
        btnList.appendChild(btn);
      }
      details.appendChild(btnList);
      closingDiv.appendChild(details);
    }

    // ── Register document-panel callbacks so extractions auto-populate toggles ──
    const autoPopBadges = {}; // toggleId → filename (for future badge rendering)

    function applyExtractionToMaState(result, filename) {
      if (!result?.extracted) return;
      const d = result.extracted;
      let changed = false;

      if (result.type === 'WILL') {
        if (d.willDate && !maState.toggleAnswers.willDate) {
          maState.toggleAnswers.willDate = d.willDate;
          autoPopBadges.willDate = filename;
          changed = true;
        }
        if (d.suretiesWaived !== undefined && maState.toggleAnswers.suretyWaived === undefined) {
          maState.toggleAnswers.suretyWaived = d.suretiesWaived;
          autoPopBadges.suretyWaived = filename;
          changed = true;
        }
        if (d.nominationPowerGranted !== undefined && maState.toggleAnswers.willAllowsNomination === undefined) {
          maState.toggleAnswers.willAllowsNomination = d.nominationPowerGranted;
          autoPopBadges.willAllowsNomination = filename;
          changed = true;
        }
        if (d.supervisedAdminDirected === true && maState.toggleAnswers.supervisedRequired === undefined) {
          maState.toggleAnswers.supervisedRequired = true;
          autoPopBadges.supervisedRequired = filename;
          changed = true;
        }
        if (d.hasAttestationClause !== undefined && maState.toggleAnswers.noAttestationClause === undefined) {
          maState.toggleAnswers.noAttestationClause = !d.hasAttestationClause;
          autoPopBadges.noAttestationClause = filename;
          changed = true;
        }
      }

      if (result.type === 'DEATH_CERT') {
        if (d.isHomicideOrPending === true && maState.toggleAnswers.causeOfDeathPending === undefined) {
          maState.toggleAnswers.causeOfDeathPending = true;
          autoPopBadges.causeOfDeathPending = filename;
          changed = true;
        }
      }

      if (changed) {
        renderTogglePanel();
        renderFormSet();
        renderIndivForms();
      }
    }

    // Register with the document panel (it may already have completed extractions)
    const docPanelRef = buildDocumentPanel._registry?.get(matterId);
    // Use the module-level matterMaCallbacks Map
    matterMaCallbacks.set(matterId, {
      applyExtraction: applyExtractionToMaState,
      addWillDevisees(devisees) {
        // Store for future MPC-163 generation
        if (!maState.toggleAnswers.willOnlyDevisees) maState.toggleAnswers.willOnlyDevisees = [];
        for (const dev of devisees) {
          if (!maState.toggleAnswers.willOnlyDevisees.find(d => d.name === dev.name)) {
            maState.toggleAnswers.willOnlyDevisees.push(dev);
          }
        }
      },
    });

    // Initial render (no analysis data yet)
    renderProceedingToggle();
    renderTogglePanel();
    renderFormSet();
    renderGenBtn();
    renderIndivForms();
    renderClosingForms();

    // Loading state in auto panel while we fetch
    autoPanelDiv.appendChild(
      el('div', { className: 'loading', style: 'font-size:.875rem' }, 'Loading analysis from DecisionVault…')
    );

    // Fetch analysis and update
    apiFetch(`/api/ma/matter/${matterId}/analysis`)
      .then(data => {
        maState.analysisData = data;

        // Apply auto-answered toggles (don't overwrite user choices)
        for (const [id, val] of Object.entries(data.autoAnsweredToggles || {})) {
          if (maState.toggleAnswers[id] === undefined) maState.toggleAnswers[id] = val;
        }

        // Apply suggested proceeding type only if user hasn't changed it
        if (data.suggestedProceedingType && maState.proceedingType === 'informalIntestate') {
          maState.proceedingType = data.suggestedProceedingType;
        }

        renderAutoPanel();
        renderInterestedParties();
        renderMPC455Panel();
        renderProceedingToggle();
        renderTogglePanel();
        renderFormSet();
        renderIndivForms();
      })
      .catch(err => {
        clearEl(autoPanelDiv);
        autoPanelDiv.appendChild(
          el('div', { className: 'error' }, 'Analysis failed: ' + err.message)
        );
        renderInterestedParties();
        renderMPC455Panel();
      });
  }

  // ── Alert functions ───────────────────────────────────────────────────────

  async function loadAlerts(force = false) {
    try {
      alertData = await apiFetch('/api/alerts' + (force ? '?refresh=1' : ''));
      alertsByMatter = new Map();
      for (const a of alertData.alerts || []) {
        let entry = alertsByMatter.get(a.matterId);
        if (!entry) { entry = { overdue: 0, urgent: 0, upcoming: 0, items: [] }; alertsByMatter.set(a.matterId, entry); }
        entry[a.severity]++;
        entry.items.push(a);
      }
      updateBellBadge(alertData);
      // Refresh kanban chips if board is already rendered
      if (kanbanCards.length > 0) renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
      // Refresh panel if it's open
      if (document.getElementById('alert-panel')?.classList.contains('open')) renderAlertPanel(alertData);
    } catch (err) {
      console.warn('Alert load failed:', err.message);
    }
  }

  function updateBellBadge(data) {
    const bell  = document.getElementById('sidebar-bell');
    const badge = document.getElementById('sidebar-bell-badge');
    if (!bell || !badge) return;
    const total = data?.alertCount || 0;
    if (total === 0) { bell.classList.remove('visible'); return; }
    bell.classList.add('visible');
    badge.textContent = total;
    badge.className = (data?.summary?.overdue > 0) ? 'sidebar-bell-badge' : 'sidebar-bell-badge urgent-only';
  }

  function openAlertPanel() {
    renderAlertPanel(alertData);
    document.getElementById('alert-panel')?.classList.add('open');
    document.getElementById('alert-overlay').style.display = 'block';
  }

  function closeAlertPanel() {
    document.getElementById('alert-panel')?.classList.remove('open');
    document.getElementById('alert-overlay').style.display = 'none';
  }

  function renderAlertPanel(data) {
    const body = document.getElementById('alert-panel-body');
    if (!body) return;
    body.innerHTML = '';
    if (!data || !data.alerts || data.alerts.length === 0) {
      body.innerHTML = '<div class="alert-panel-empty">✓ No active deadline alerts</div>';
      return;
    }
    const groups = [
      { severity: 'overdue',  label: '🔴 OVERDUE' },
      { severity: 'urgent',   label: '🟠 URGENT — Due within 14 days' },
      { severity: 'upcoming', label: '🟡 UPCOMING — Due within 30 days' },
    ];
    for (const { severity, label } of groups) {
      const list = data.alerts.filter(a => a.severity === severity);
      if (!list.length) continue;
      const heading = document.createElement('div');
      heading.className = `alert-group-heading ${severity}`;
      heading.textContent = `${label} (${list.length})`;
      body.appendChild(heading);
      for (const alert of list) {
        const dayAbs = Math.abs(alert.daysRemaining);
        const dayStr = alert.daysRemaining < 0
          ? `${dayAbs} day${dayAbs !== 1 ? 's' : ''} overdue`
          : alert.daysRemaining === 0 ? 'Due today'
          : `Due in ${alert.daysRemaining} day${alert.daysRemaining !== 1 ? 's' : ''}`;
        const item = el('div', { className: `alert-item ${severity}` });
        item.appendChild(el('div', { className: 'alert-item-matter' }, alert.matterName));
        item.appendChild(el('div', { className: 'alert-item-label' }, alert.deadlineLabel));
        item.appendChild(el('div', { className: 'alert-item-due' }, `${alert.dueDateDisplay} · ${dayStr}`));
        if (alert.statute) item.appendChild(el('div', { className: 'alert-item-statute' }, alert.statute));
        const actions = el('div', { className: 'alert-item-actions' });
        const openBtn = el('button', { className: 'kanban-btn primary' }, 'Open Matter');
        openBtn.addEventListener('click', () => { closeAlertPanel(); viewMatterFromKanban(alert.matterId); });
        const dismissBtn = el('button', { className: 'kanban-btn' }, 'Dismiss');
        dismissBtn.addEventListener('click', async () => {
          dismissBtn.disabled = true; dismissBtn.textContent = '…';
          try {
            await apiFetch(`/api/alerts/${encodeURIComponent(alert.alertId)}/dismiss`, { method: 'POST' });
            await loadAlerts(true);
          } catch { dismissBtn.disabled = false; dismissBtn.textContent = 'Dismiss'; }
        });
        actions.appendChild(openBtn); actions.appendChild(dismissBtn);
        item.appendChild(actions);
        body.appendChild(item);
      }
    }
  }

  // ── Flags functions ───────────────────────────────────────────────────────

  async function loadFlags() {
    try {
      const data = await apiFetch('/api/flags');
      flagsData = data.flags || [];
      flagsByMatter = new Map();
      for (const f of flagsData) {
        if (f.resolvedAt) continue;
        let list = flagsByMatter.get(f.matterId);
        if (!list) { list = []; flagsByMatter.set(f.matterId, list); }
        list.push(f);
      }
      updateFlagBadge();
      if (document.getElementById('flag-panel')?.classList.contains('open')) renderFlagPanel();
    } catch (err) {
      console.warn('Flag load failed:', err.message);
    }
  }

  function updateFlagBadge() {
    const btn   = document.getElementById('sidebar-flag');
    const badge = document.getElementById('sidebar-flag-badge');
    if (!btn || !badge) return;
    const highCount = flagsData.filter(f => !f.resolvedAt && f.severity === 'high').length;
    if (highCount === 0) { btn.classList.remove('visible'); return; }
    btn.classList.add('visible');
    badge.textContent = highCount;
  }

  function openFlagPanel() {
    renderFlagPanel();
    document.getElementById('flag-panel')?.classList.add('open');
    document.getElementById('flag-overlay').style.display = 'block';
  }

  function closeFlagPanel() {
    document.getElementById('flag-panel')?.classList.remove('open');
    document.getElementById('flag-overlay').style.display = 'none';
  }

  function renderFlagPanel() {
    const body = document.getElementById('flag-panel-body');
    if (!body) return;
    body.innerHTML = '';
    const open = flagsData.filter(f => !f.resolvedAt);
    if (!open.length) {
      body.innerHTML = '<div class="flag-panel-empty">✓ No open document flags</div>';
      return;
    }
    const groups = [
      { severity: 'high',   label: '🔴 HIGH — Action Required' },
      { severity: 'medium', label: '🟡 MEDIUM — Attention Needed' },
      { severity: 'low',    label: '⚪ LOW — Informational' },
    ];
    for (const { severity, label } of groups) {
      const list = open.filter(f => f.severity === severity);
      if (!list.length) continue;
      const heading = document.createElement('div');
      heading.className = `flag-group-heading ${severity}`;
      heading.textContent = `${label} (${list.length})`;
      body.appendChild(heading);
      for (const flag of list) {
        const item = el('div', { className: `flag-item ${severity}` });
        item.appendChild(el('div', { className: 'flag-item-matter' }, flag.matterName));
        item.appendChild(el('div', { className: 'flag-item-message' }, flag.message));
        const raised = new Date(flag.raisedAt).toLocaleDateString();
        item.appendChild(el('div', { className: 'flag-item-meta' }, `Raised: ${raised}${flag.acknowledgedAt ? ' · Acknowledged' : ''}`));
        const actions = el('div', { className: 'flag-item-actions' });
        if (!flag.acknowledgedAt) {
          const ackBtn = el('button', { className: 'kanban-btn' }, 'Acknowledge');
          ackBtn.addEventListener('click', async () => {
            ackBtn.disabled = true; ackBtn.textContent = '…';
            try { await apiFetch(`/api/flags/${flag.id}/acknowledge`, { method: 'POST' }); await loadFlags(); }
            catch { ackBtn.disabled = false; ackBtn.textContent = 'Acknowledge'; }
          });
          actions.appendChild(ackBtn);
        }
        const resolveBtn = el('button', { className: 'kanban-btn primary' }, 'Resolve');
        resolveBtn.addEventListener('click', async () => {
          resolveBtn.disabled = true; resolveBtn.textContent = '…';
          try { await apiFetch(`/api/flags/${flag.id}/resolve`, { method: 'POST' }); await loadFlags(); }
          catch { resolveBtn.disabled = false; resolveBtn.textContent = 'Resolve'; }
        });
        actions.appendChild(resolveBtn);
        item.appendChild(actions);
        body.appendChild(item);
      }
    }
  }

  // ── AI Settings functions ─────────────────────────────────────────────────

  async function loadAiSettings() {
    try {
      aiSettings = await apiFetch('/api/ai-settings');
      renderAiSettingsPanel();
    } catch (err) {
      console.warn('AI settings load failed:', err.message);
    }
  }

  async function updateAiSetting(key, value) {
    try {
      const result = await apiFetch('/api/ai-settings', {
        method: 'POST',
        body: JSON.stringify({ [key]: value }),
      });
      aiSettings = { ...aiSettings, ...result.settings };
    } catch (err) {
      console.warn('AI settings save failed:', err.message);
      renderAiSettingsPanel(); // revert UI
    }
  }

  function renderAiSettingsPanel() {
    const alertToggle     = document.getElementById('ai-toggle-alerts');
    const scannerToggle   = document.getElementById('ai-toggle-scanner');
    const extractToggle   = document.getElementById('ai-toggle-extraction');
    const extractionNote  = document.getElementById('ai-extraction-note');
    const runAlertsBtn    = document.getElementById('ai-run-alerts');
    const runScannerBtn   = document.getElementById('ai-run-scanner');

    if (alertToggle)    alertToggle.checked  = !!aiSettings.AI_DEADLINE_ALERTS;
    if (scannerToggle)  scannerToggle.checked = !!aiSettings.AI_DOCUMENT_SCANNER;
    if (extractToggle)  {
      extractToggle.checked  = !!aiSettings.AI_EXTRACTION;
      extractToggle.disabled = !aiSettings.AI_EXTRACTION_AVAILABLE;
    }
    if (extractionNote) {
      extractionNote.textContent = aiSettings.AI_EXTRACTION_AVAILABLE ? '' : '(requires API key)';
    }
    if (runAlertsBtn)   runAlertsBtn.disabled  = !aiSettings.AI_DEADLINE_ALERTS;
    if (runScannerBtn)  runScannerBtn.disabled  = !aiSettings.AI_DOCUMENT_SCANNER;
  }

  function updateScanStatus() {
    apiFetch('/api/scan/history').then(h => {
      const el = document.getElementById('sidebar-scan-status');
      if (!el) return;
      if (!h.lastRun) { el.textContent = 'Last scan: —'; return; }
      const mins = Math.round((Date.now() - new Date(h.lastRun).getTime()) / 60000);
      const timeStr = mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
      el.textContent = `Last scan: ${timeStr}`;
    }).catch(() => {});
  }

  // ── Kanban Dashboard ──────────────────────────────────────────────────────

  function categorizeMatter(internalType) {
    const t = (internalType || '').toLowerCase().replace(/[\s-]/g, '');
    if (t.includes('guardianship') || t.includes('conservatorship')) return 'guardianship';
    if (t.includes('probate') || t === 'rhodeislandprobate' || t === 'massachusettsprobate') return 'probate';
    if (t.includes('trust') && !t.includes('planning')) return 'trust';
    if (t.includes('planning') || t === 'planning') return 'planning';
    if (t.includes('litigation')) return 'litigation';
    return 'other';
  }

  async function loadKanban(force = false) {
    const board = document.getElementById('kanban-board');
    if (!board) return;
    const columns = kanbanBoardMode === 'planning' ? PLANNING_KANBAN_COLUMNS : KANBAN_COLUMNS;
    board.innerHTML = '';
    for (const col of columns) {
      board.appendChild(buildColumnSkeleton(col));
    }
    try {
      const data = await apiFetch('/api/admin/kanban' + (force ? '?refresh=1' : ''));
      kanbanCards = data.cards || [];
      renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
    } catch (err) {
      board.innerHTML = `<div class="error" style="padding:1rem">Failed to load kanban: ${err.message}</div>`;
    }
  }

  function buildColumnSkeleton(col) {
    const colEl = document.createElement('div');
    colEl.className = 'kanban-col';
    const header = document.createElement('div');
    header.className = 'kanban-col-header';
    const dot = document.createElement('span');
    dot.className = 'kanban-col-dot';
    dot.style.background = col.color;
    header.appendChild(dot);
    header.appendChild(document.createTextNode(col.label));
    colEl.appendChild(header);
    const body = document.createElement('div');
    body.className = 'kanban-col-body';
    for (let i = 0; i < 2; i++) {
      const sk = document.createElement('div');
      sk.className = 'kanban-skeleton-card';
      sk.innerHTML = '<div class="sk-line medium"></div><div class="sk-line short"></div><div class="sk-line full"></div>';
      body.appendChild(sk);
    }
    colEl.appendChild(body);
    return colEl;
  }

  function renderKanbanCards(cards, search, stateFilter) {
    const board = document.getElementById('kanban-board');
    if (!board) return;
    const columns = kanbanBoardMode === 'planning' ? PLANNING_KANBAN_COLUMNS : KANBAN_COLUMNS;
    const q = (search || '').toLowerCase().trim();
    const filtered = cards.filter(c => {
      const cat = c.matterCategory || categorizeMatter(c.internalType);
      const isPlanning = cat === 'planning';
      if (kanbanBoardMode === 'planning' && !isPlanning) return false;
      if (kanbanBoardMode === 'admin' && isPlanning) return false;
      if (kanbanCategoryFilter !== 'ALL' && cat !== kanbanCategoryFilter) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (stateFilter !== 'ALL') {
        const t = (c.internalType || '').toLowerCase();
        if (stateFilter === 'RI' && !t.includes('rhodeisland') && !t.includes('rhode island')) return false;
        if (stateFilter === 'MA' && !t.includes('massachusetts')) return false;
      }
      return true;
    });

    board.innerHTML = '';
    for (const col of columns) {
      const colCards = filtered.filter(c => c.stage === col.id);
      const colEl = document.createElement('div');
      colEl.className = 'kanban-col';
      colEl.dataset.colId = col.id;

      const header = document.createElement('div');
      header.className = 'kanban-col-header';
      const dot = document.createElement('span');
      dot.className = 'kanban-col-dot';
      dot.style.background = col.color;
      const countBadge = document.createElement('span');
      countBadge.className = 'kanban-col-count';
      countBadge.textContent = colCards.length;
      const colToggleBtn = document.createElement('button');
      colToggleBtn.className = 'kanban-col-toggle';
      colToggleBtn.title = 'Collapse/expand column';
      colToggleBtn.textContent = (kanbanCollapsedAll || kanbanCollapsedCols.has(col.id)) ? '▶' : '▼';
      colToggleBtn.addEventListener('click', () => toggleColumn(col.id, colToggleBtn));
      header.appendChild(dot);
      header.appendChild(document.createTextNode(col.label));
      header.appendChild(countBadge);
      header.appendChild(colToggleBtn);
      colEl.appendChild(header);

      const body = document.createElement('div');
      body.className = 'kanban-col-body';
      setupDropZone(body, col.id);

      if (colCards.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'kanban-col-empty';
        empty.textContent = 'No matters';
        body.appendChild(empty);
      } else {
        for (const card of colCards) {
          body.appendChild(buildCard(card, col));
        }
      }
      colEl.appendChild(body);
      board.appendChild(colEl);
    }
  }

  function buildCard(card, col) {
    const isColCollapsed = kanbanCollapsedAll || kanbanCollapsedCols.has(col.id);
    const isCardCollapsed = isColCollapsed || kanbanCollapsedCards.has(card.matterId);

    const cardEl = document.createElement('div');
    cardEl.className = 'kanban-card' + (card.isOverdue ? ' overdue' : '') + (isCardCollapsed ? ' collapsed' : '');
    cardEl.style.borderLeftColor = col.color;
    cardEl.setAttribute('draggable', 'true');
    cardEl.dataset.matterId = card.matterId;
    cardEl.dataset.stage = card.stage;

    cardEl.addEventListener('dragstart', e => {
      kanbanDragMatterId  = card.matterId;
      kanbanDragFromStage = card.stage;
      e.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      kanbanDragMatterId  = null;
      kanbanDragFromStage = null;
    });

    // ── Summary row (always visible) ──
    const summaryEl = document.createElement('div');
    summaryEl.className = 'kanban-card-summary';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'kanban-card-toggle';
    toggleBtn.textContent = isCardCollapsed ? '▶' : '▼';
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleCard(card.matterId, toggleBtn, cardEl);
    });
    summaryEl.appendChild(toggleBtn);

    // Alert severity dot
    const totalAlerts = (card.alerts?.overdue || 0) + (card.alerts?.urgent || 0) + (card.alerts?.upcoming || 0);
    if (totalAlerts > 0) {
      const dotCls = card.alerts?.overdue > 0 ? 'overdue' : card.alerts?.urgent > 0 ? 'urgent' : 'upcoming';
      const dot = el('span', { className: `alert-severity-dot ${dotCls}` }, '●');
      const o = card.alerts?.overdue || 0, u = card.alerts?.urgent || 0, up = card.alerts?.upcoming || 0;
      dot.title = [o && `${o} overdue`, u && `${u} urgent`, up && `${up} upcoming`].filter(Boolean).join(', ');
      summaryEl.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'kanban-card-name';
    nameEl.title = card.name;
    nameEl.textContent = card.name;
    summaryEl.appendChild(nameEl);

    if ((card.warningTaskCount || 0) > 0) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'kanban-warning-badge';
      warnBadge.title = `${card.warningTaskCount} skipped task${card.warningTaskCount !== 1 ? 's' : ''}`;
      warnBadge.textContent = `⚠ ${card.warningTaskCount}`;
      summaryEl.appendChild(warnBadge);
    }
    // Flag badge (high-severity open flags for this matter)
    const matterFlags = flagsByMatter.get(card.matterId) || [];
    const highFlags = matterFlags.filter(f => f.severity === 'high').length;
    if (highFlags > 0) {
      const flagBadge = document.createElement('span');
      flagBadge.className = 'kanban-flag-badge';
      flagBadge.title = `${highFlags} high-severity document flag${highFlags !== 1 ? 's' : ''}`;
      flagBadge.textContent = `🚩${highFlags}`;
      summaryEl.appendChild(flagBadge);
    }
    cardEl.appendChild(summaryEl);

    // ── Detail section (collapsible) ──
    const detailEl = document.createElement('div');
    detailEl.className = 'kanban-card-detail';

    if (card.internalType) {
      const typeEl = document.createElement('div');
      typeEl.className = 'kanban-card-type';
      typeEl.textContent = card.internalType.replace(/([A-Z])/g, ' $1').trim();
      detailEl.appendChild(typeEl);
    }

    detailEl.appendChild(buildCardHearingSection(card));

    // Alert chips (from detailed /api/alerts data)
    const matterAlerts = alertsByMatter.get(card.matterId);
    if (matterAlerts && matterAlerts.items.length > 0) {
      const chipsEl = el('div', { className: 'kanban-alert-chips' });
      for (const a of matterAlerts.items.slice(0, 4)) {
        const shortLabel = a.deadlineLabel.split(' ').slice(0, 4).join(' ');
        const dayStr = a.daysRemaining < 0 ? `${Math.abs(a.daysRemaining)}d late` : `${a.daysRemaining}d`;
        const chip = el('span', { className: `kanban-alert-chip ${a.severity}` }, `${shortLabel} · ${dayStr}`);
        chip.title = `${a.deadlineLabel} — ${a.dueDateDisplay}${a.statute ? '\n' + a.statute : ''}`;
        chipsEl.appendChild(chip);
      }
      detailEl.appendChild(chipsEl);
    }

    // Flag chips (from flags data)
    if (matterFlags.length > 0) {
      const flagChipsEl = el('div', { className: 'kanban-alert-chips' });
      for (const f of matterFlags.slice(0, 3)) {
        const chip = el('span', { className: 'kanban-flag-badge' }, `🚩 ${f.type.replace(/_/g, ' ').toLowerCase()}`);
        chip.title = f.message;
        flagChipsEl.appendChild(chip);
      }
      detailEl.appendChild(flagChipsEl);
    }

    if (card.previewTasks && card.previewTasks.length > 0) {
      const tasksEl = document.createElement('div');
      tasksEl.className = 'kanban-card-tasks';
      for (const label of card.previewTasks.slice(0, 5)) {
        const item = document.createElement('div');
        item.className = 'kanban-task-item';
        item.textContent = label;
        tasksEl.appendChild(item);
      }
      detailEl.appendChild(tasksEl);
    }

    const footer = document.createElement('div');
    footer.className = 'kanban-card-footer';

    const countEl = document.createElement('span');
    countEl.className = 'kanban-open-count';
    countEl.textContent = card.openTaskCount === 0 ? 'All tasks done' : `${card.openTaskCount} open tasks`;
    footer.appendChild(countEl);

    const allCols = kanbanBoardMode === 'planning' ? PLANNING_KANBAN_COLUMNS : KANBAN_COLUMNS;
    const colIdx = allCols.findIndex(c => c.id === card.stage);
    if (colIdx >= 0 && colIdx < allCols.length - 1) {
      const advBtn = document.createElement('button');
      advBtn.className = 'kanban-btn';
      advBtn.textContent = 'Advance';
      advBtn.addEventListener('click', () => kanbanAdvanceCard(card, col));
      footer.appendChild(advBtn);
    }

    const viewBtn = document.createElement('button');
    viewBtn.className = 'kanban-btn primary';
    viewBtn.textContent = 'Open';
    viewBtn.addEventListener('click', () => viewMatterFromKanban(card.matterId));
    footer.appendChild(viewBtn);

    detailEl.appendChild(footer);
    cardEl.appendChild(detailEl);
    return cardEl;
  }

  function toggleCard(matterId, toggleBtn, cardEl) {
    if (kanbanCollapsedCards.has(matterId)) kanbanCollapsedCards.delete(matterId);
    else kanbanCollapsedCards.add(matterId);
    const collapsed = kanbanCollapsedCards.has(matterId);
    if (cardEl) cardEl.classList.toggle('collapsed', collapsed);
    if (toggleBtn) toggleBtn.textContent = collapsed ? '▶' : '▼';
  }

  function toggleColumn(colId, colToggleBtn) {
    if (kanbanCollapsedCols.has(colId)) kanbanCollapsedCols.delete(colId);
    else kanbanCollapsedCols.add(colId);
    const isCollapsed = kanbanCollapsedCols.has(colId);
    if (colToggleBtn) colToggleBtn.textContent = isCollapsed ? '▶' : '▼';
    document.querySelectorAll(`.kanban-col[data-col-id="${colId}"] .kanban-card`).forEach(card => {
      card.classList.toggle('collapsed', isCollapsed);
      const btn = card.querySelector('.kanban-card-toggle');
      if (btn) btn.textContent = isCollapsed ? '▶' : '▼';
    });
  }

  function toggleAllCards(collapse) {
    kanbanCollapsedAll = collapse;
    if (collapse) {
      document.querySelectorAll('.kanban-card').forEach(c => {
        c.classList.add('collapsed');
        const btn = c.querySelector('.kanban-card-toggle');
        if (btn) btn.textContent = '▶';
      });
      document.querySelectorAll('.kanban-col-toggle').forEach(b => { b.textContent = '▶'; });
    } else {
      kanbanCollapsedCards.clear();
      kanbanCollapsedCols.clear();
      document.querySelectorAll('.kanban-card').forEach(c => {
        c.classList.remove('collapsed');
        const btn = c.querySelector('.kanban-card-toggle');
        if (btn) btn.textContent = '▼';
      });
      document.querySelectorAll('.kanban-col-toggle').forEach(b => { b.textContent = '▼'; });
    }
    const colBtn = document.getElementById('kanban-collapse-all');
    if (colBtn) colBtn.textContent = collapse ? 'Expand All' : 'Collapse All';
  }

  function buildCardHearingSection(card) {
    const wrap = document.createElement('div');

    if (card.nextHearingDate) {
      const hearingEl = document.createElement('div');
      hearingEl.className = 'kanban-card-hearing' + (card.isOverdue ? ' overdue' : '');
      const dateStr = card.nextHearingDate.slice(0, 10);
      hearingEl.textContent = card.isOverdue
        ? `Overdue: ${dateStr}${card.nextHearingDescription ? ' — ' + card.nextHearingDescription : ''}`
        : `Hearing: ${dateStr}${card.nextHearingDescription ? ' — ' + card.nextHearingDescription : ''}`;
      wrap.appendChild(hearingEl);
    }

    // Inline hearing form (hidden by default)
    const formEl = document.createElement('div');
    formEl.className = 'kanban-hearing-form';
    formEl.style.display = 'none';

    const dateInput = document.createElement('input');
    dateInput.type = 'text';
    dateInput.className = 'kanban-hearing-input';
    dateInput.placeholder = 'YYYY-MM-DD';
    dateInput.value = card.nextHearingDate || '';

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'kanban-hearing-input';
    descInput.placeholder = 'Description (optional)';
    descInput.value = card.nextHearingDescription || '';

    const actions = document.createElement('div');
    actions.className = 'kanban-hearing-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'kanban-btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      await saveHearingDate(card.matterId, dateInput.value.trim(), descInput.value.trim());
      card.nextHearingDate = dateInput.value.trim() || null;
      card.nextHearingDescription = descInput.value.trim() || null;
      const today = new Date(); today.setHours(0,0,0,0);
      card.isOverdue = !!(card.nextHearingDate && new Date(card.nextHearingDate) < today);
      formEl.style.display = 'none';
      renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'kanban-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { formEl.style.display = 'none'; });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    formEl.appendChild(dateInput);
    formEl.appendChild(descInput);
    formEl.appendChild(actions);

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'kanban-btn';
    toggleBtn.style.marginTop = '0.25rem';
    toggleBtn.textContent = card.nextHearingDate ? 'Edit Hearing' : 'Add Hearing';
    toggleBtn.addEventListener('click', () => {
      formEl.style.display = formEl.style.display === 'none' ? 'flex' : 'none';
      formEl.style.flexDirection = 'column';
    });

    wrap.appendChild(toggleBtn);
    wrap.appendChild(formEl);
    return wrap;
  }

  function setupDropZone(bodyEl, stageId) {
    bodyEl.addEventListener('dragover', e => {
      e.preventDefault();
      bodyEl.classList.add('drag-over');
    });
    bodyEl.addEventListener('dragleave', e => {
      if (!bodyEl.contains(e.relatedTarget)) bodyEl.classList.remove('drag-over');
    });
    bodyEl.addEventListener('drop', async e => {
      e.preventDefault();
      bodyEl.classList.remove('drag-over');
      if (kanbanDragMatterId && kanbanDragFromStage !== stageId) {
        await kanbanMoveCard(kanbanDragMatterId, stageId);
      }
    });
  }

  async function kanbanMoveCard(matterId, toStage) {
    try {
      await apiFetch(`/api/admin/matter/${matterId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: toStage }),
      });
      const card = kanbanCards.find(c => c.matterId === matterId);
      if (card) card.stage = toStage;
      renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
    } catch (err) {
      alert('Failed to move matter: ' + err.message);
    }
  }

  async function kanbanAdvanceCard(card, col) {
    const allCols = kanbanBoardMode === 'planning' ? PLANNING_KANBAN_COLUMNS : KANBAN_COLUMNS;
    const colIdx = allCols.findIndex(c => c.id === col.id);
    if (colIdx < 0 || colIdx >= allCols.length - 1) return;
    const nextCol = allCols[colIdx + 1];
    const pendingCount = card.pendingTaskCount || 0;
    if (pendingCount > 0) {
      const msg = `"${card.name}" has ${pendingCount} incomplete task${pendingCount !== 1 ? 's' : ''} in "${col.label}".\n\n` +
        `Advance to "${nextCol.label}" anyway?\n` +
        `• Incomplete tasks → marked as skipped (⚠)\n` +
        `• Future stage tasks → marked open`;
      if (!confirm(msg)) return;
      const result = await apiFetch(`/api/admin/matter/${card.matterId}/advance`, {
        method: 'POST',
        body: JSON.stringify({ fromStage: card.stage, toStage: nextCol.id }),
      });
      card.warningTaskCount = (card.warningTaskCount || 0) + pendingCount;
      card.pendingTaskCount = 0;
      card.openTaskCount = 0;
      card.previewTasks = [];
      card.stage = nextCol.id;
    } else {
      if (!confirm(`Advance "${card.name}" to "${nextCol.label}"?`)) return;
      const result = await apiFetch(`/api/admin/matter/${card.matterId}/advance`, {
        method: 'POST',
        body: JSON.stringify({ fromStage: card.stage, toStage: nextCol.id }),
      });
      card.stage = nextCol.id;
    }
    renderKanbanCards(kanbanCards, kanbanSearch, kanbanStateFilter);
  }

  function viewMatterFromKanban(matterId) {
    showView('matters');
    const li = document.querySelector(`#matters-list li[data-id="${matterId}"]`);
    loadMatter(matterId, li);
  }

  async function saveHearingDate(matterId, date, description) {
    await apiFetch(`/api/admin/matter/${matterId}/hearing`, {
      method: 'POST',
      body: JSON.stringify({ nextHearingDate: date || null, nextHearingDescription: description || null }),
    });
  }

  // ── Administration Tab ──────────────────────────────────────────────────────

  const ADMIN_STAGES = [
    { id: 'PETITION_PREP',     label: 'Petition Prep'     },
    { id: 'FILED',             label: 'Filed'             },
    { id: 'APPOINTED',         label: 'Appointed'         },
    { id: 'IN_ADMINISTRATION', label: 'In Administration' },
    { id: 'CLOSING_PREP',      label: 'Closing Prep'      },
    { id: 'CLOSED',            label: 'Closed'            },
  ];

  const ADMIN_KEY_DATES = [
    { key: 'dateOfDeath',              label: 'Date of Death' },
    { key: 'appointmentDate',          label: 'Date of Appointment' },
    { key: 'filingDate',               label: 'Filing Date' },
    { key: 'publicationDate',          label: 'First Publication Date (RI)' },
    { key: 'nextHearingDate',          label: 'Next Hearing Date' },
    { key: 'nextHearingDescription',   label: 'Hearing Description' },
  ];

  const ADMIN_LETTERS = [
    { id: 'initial_client',  label: 'Initial Client Letter',             description: 'Welcome letter with next steps and key deadlines' },
    { id: 'engagement',      label: 'Engagement / Retainer Letter',      description: 'Formal retainer letter with fee agreement' },
    { id: 'dma_notice',      label: 'DMA Notice Cover Letter',           description: 'MassHealth Estate Recovery Unit notice (MA)' },
    { id: 'heir_notice',     label: 'Notice to Heir / Interested Party', description: 'Notice of pending petition to heirs' },
    { id: 'creditor_notice', label: 'Creditor Notice Letter',            description: 'Notice to known creditors with claim deadline' },
    { id: 'asset_inquiry',   label: 'Asset / Account Inquiry Letter',    description: 'Request account info from financial institutions' },
    { id: 'inventory_cover', label: 'Inventory Filing Cover Letter',     description: 'Cover letter for filing MPC 854 with court' },
    { id: 'status_update',   label: 'Client Status Update',              description: 'Periodic update with next 3 upcoming deadlines' },
    { id: 'distribution',    label: 'Distribution Letter',               description: 'Accompanies distribution to beneficiaries' },
    { id: 'closing',         label: 'Closing Letter',                    description: 'Final letter confirming administration complete' },
    // Trust letters
    { id: 'letter_trustee_affidavit',            label: 'Affidavit of Successor Trustee',      description: 'Affidavit confirming trustee appointment (for recording)' },
    { id: 'letter_certification_of_trust',       label: 'Certification of Trust',               description: 'Statutory certification for financial institutions' },
    { id: 'letter_trustee_notice_to_beneficiaries', label: 'Trustee Notice to Beneficiaries',  description: 'Statutory 60-day notice of trustee appointment' },
    { id: 'letter_trust_accounting',             label: 'Trust Accounting Cover Letter',        description: 'Transmits annual or final trust accounting to beneficiaries' },
    { id: 'letter_trust_termination',            label: 'Trust Termination Letter',             description: 'Final accounting and distribution upon trust termination' },
  ];

  function buildAdminUI(matterId, matter, container) {
    const body = el('div', { className: 'admin-body' });

    // ── Closure state ──
    let adminState  = { stage: 'PETITION_PREP', keyDates: {}, tasks: {}, state: 'MA' };
    let deadlines   = [];
    let taskStages  = [];   // fetched from /api/admin/matter/:id/tasks/staged
    let tasksLoaded = false;

    // ── Stage progress indicator ──
    const stageIndicatorDiv = el('div', {});
    body.appendChild(stageIndicatorDiv);

    function renderStageIndicator() {
      clearEl(stageIndicatorDiv);
      const currentIdx = ADMIN_STAGES.findIndex(s => s.id === adminState.stage);
      const row = el('div', { className: 'admin-stage-indicator' });
      for (let i = 0; i < ADMIN_STAGES.length; i++) {
        const { label } = ADMIN_STAGES[i];
        const isPast    = i < currentIdx;
        const isCurrent = i === currentIdx;
        const pill = el('div', {
          className: 'admin-stage-pill' + (isCurrent ? ' current' : isPast ? ' past' : ' future'),
        });
        if (isPast) pill.appendChild(el('span', { style: 'margin-right:2px;font-size:0.65rem' }, '✓'));
        pill.appendChild(document.createTextNode(label));
        row.appendChild(pill);
        if (i < ADMIN_STAGES.length - 1) {
          row.appendChild(el('span', { className: 'admin-stage-arrow' }, '›'));
        }
      }
      stageIndicatorDiv.appendChild(row);
    }

    // ── Key dates + state toggle ──
    const datesDiv = el('div', {});
    body.appendChild(datesDiv);

    function renderDates() {
      clearEl(datesDiv);
      datesDiv.appendChild(el('div', { className: 'admin-section-header' }, 'Key Dates & State'));

      // State toggle
      const stateRow = el('div', { style: 'display:flex;align-items:center;gap:0.5rem;margin-bottom:0.65rem' });
      stateRow.appendChild(el('span', { style: 'font-size:0.78rem;color:#6b7280;font-weight:500;flex-shrink:0' }, 'State:'));
      for (const st of ['MA', 'RI']) {
        const btn = el('button', {
          className: 'state-tab' + (adminState.state === st ? ' active' : ''),
          style: 'padding:0.25rem 1rem;font-size:0.82rem',
        }, st);
        btn.addEventListener('click', () => {
          if (adminState.state === st) return;
          adminState.state = st;
          taskStages = [];
          tasksLoaded = false;
          deadlines = [];
          renderDates();
          renderDeadlines();
          renderTasks();
          loadDeadlines();
          loadTasks();
        });
        stateRow.appendChild(btn);
      }
      datesDiv.appendChild(stateRow);

      const grid = el('div', { className: 'admin-dates-grid' });
      for (const { key, label } of ADMIN_KEY_DATES) {
        const input = el('input', {
          type: 'text',
          className: 'admin-date-input',
          placeholder: 'YYYY-MM-DD',
          value: adminState.keyDates[key] || '',
        });
        let saveTimer;
        input.addEventListener('input', () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const val = input.value.trim();
            if (val) adminState.keyDates[key] = val;
            else delete adminState.keyDates[key];
            apiFetch(`/api/admin/matter/${matterId}/dates`, {
              method: 'POST',
              body: JSON.stringify({ [key]: val || null }),
            }).then(() => loadDeadlines());
          }, 600);
        });
        grid.appendChild(
          el('div', { className: 'admin-date-row' },
            el('span', { className: 'admin-date-label' }, label),
            input
          )
        );
      }
      datesDiv.appendChild(grid);
    }

    // ── Deadlines ──
    const deadlineDiv = el('div', {});
    body.appendChild(deadlineDiv);

    function badgeText(d) {
      if (d.status === 'overdue')  return `${Math.abs(d.daysUntil)}d overdue`;
      if (d.status === 'urgent')   return `${d.daysUntil}d — urgent`;
      if (d.status === 'upcoming') return `${d.daysUntil}d`;
      if (d.status === 'future')   return `${d.daysUntil}d`;
      return 'N/A';
    }

    function renderDeadlines() {
      clearEl(deadlineDiv);
      deadlineDiv.appendChild(el('div', { className: 'admin-section-header' },
        `Calculated Deadlines — ${adminState.state}`
      ));
      const box = el('div', { className: 'admin-deadlines' });
      if (deadlines.length === 0) {
        box.appendChild(el('div', { className: 'admin-deadline-empty' },
          'Enter key dates above to calculate deadlines.'
        ));
      } else {
        for (const d of deadlines) {
          const labelEl = el('span', { className: 'admin-deadline-label' }, d.label);
          if (d.condition) {
            labelEl.appendChild(el('span', {
              style: 'font-size:0.67rem;color:#9ca3af;margin-left:5px;font-style:italic',
            }, `(${d.condition})`));
          }
          if (d.statute) {
            labelEl.appendChild(el('span', {
              style: 'font-size:0.67rem;color:#c4b5fd;margin-left:5px',
            }, d.statute));
          }
          const row = el('div', { className: 'admin-deadline-row' },
            labelEl,
            el('span', { className: 'admin-deadline-date' }, d.dueDateDisplay),
            el('span', { className: `admin-deadline-badge ${d.status}` }, badgeText(d))
          );
          box.appendChild(row);
        }
      }
      deadlineDiv.appendChild(box);
    }

    function loadDeadlines() {
      const hasTrust = adminState.savedMatterType?.hasTrust || adminState.matterTypeOverrides?.hasTrust || false;
      apiFetch(`/api/admin/matter/${matterId}/deadlines?state=${adminState.state}&hasTrust=${hasTrust}`)
        .then(data => { deadlines = data; renderDeadlines(); if (tasksLoaded) renderTasks(); })
        .catch(() => {});
    }

    // ── Task checklist (stage-aware) ──
    const tasksDiv = el('div', {});
    body.appendChild(tasksDiv);

    const STATUS_ICONS = { completed: '✅', warning: '⚠️', na: '○', pending: '●', open: '○' };
    const STATUS_TITLES = {
      completed: 'Completed — click to cycle',
      warning:   'Skipped/Warning — click to cycle',
      na:        'N/A — click to cycle',
      pending:   'Pending — click to mark complete',
      open:      'Future stage — not yet active',
    };

    function cycleStatus(s) {
      if (s === 'pending')   return 'completed';
      if (s === 'completed') return 'na';
      if (s === 'na')        return 'pending';
      if (s === 'warning')   return 'completed';
      return 'pending';
    }

    function renderTasks() {
      // Preserve which stage accordions the user has open
      const expandedStages = new Set(
        Array.from(tasksDiv.querySelectorAll('details[data-stage]'))
          .filter(d => d.open)
          .map(d => d.dataset.stage)
      );

      console.log('=== TASK RENDER DEBUG ===');
      console.log('tasksLoaded:', tasksLoaded, '| adminState.stage:', adminState.stage, '| state:', adminState.state);
      console.log('taskStages count:', taskStages.length);
      taskStages.forEach(s => {
        console.log(`  ${s.id}: total=${s.totalCount}, isCurrent:${s.isCurrent}, isPast:${s.isPast}, isFuture:${s.isFuture}, willOpen:${s.isCurrent || expandedStages.has(s.id)}`);
      });

      clearEl(tasksDiv);
      tasksDiv.appendChild(el('div', { className: 'admin-section-header' },
        `Task Checklist — ${adminState.state}`
      ));

      if (!tasksLoaded) {
        tasksDiv.appendChild(el('div', {
          style: 'color:#9ca3af;font-size:0.82rem;font-style:italic;padding:0.5rem 0',
        }, 'Loading tasks…'));
        return;
      }

      if (!taskStages || taskStages.length === 0) {
        tasksDiv.appendChild(el('div', { style: 'color:#9ca3af;font-size:0.82rem;padding:0.5rem 0' },
          'No tasks available for this matter and state.'
        ));
        return;
      }

      const deadlineByKey = {};
      for (const d of deadlines) deadlineByKey[d.key] = d;

      for (const stage of taskStages) {
        if (stage.totalCount === 0) continue;

        const details = document.createElement('details');
        details.className = `admin-phase admin-stage-section ${
          stage.isCurrent ? 'stage-current' : stage.isPast ? 'stage-past' : 'stage-future'
        }`;
        details.dataset.stage = stage.id;
        if (stage.isCurrent || expandedStages.has(stage.id)) details.setAttribute('open', '');

        const summary = document.createElement('summary');
        summary.className = 'admin-stage-summary';

        let headingText = stage.label;
        if (stage.isCurrent)      headingText += ' — Current';
        else if (stage.isPast)    headingText += ' — Past';
        else                      headingText += ' — Upcoming';

        summary.appendChild(document.createTextNode(headingText));

        const parts = [];
        if (stage.completed)  parts.push(`${stage.completed} done`);
        if (stage.warning)    parts.push(`${stage.warning} ⚠`);
        if (stage.na)         parts.push(`${stage.na} N/A`);
        if ((stage.pending || 0) > 0 && !stage.isFuture) parts.push(`${stage.pending} pending`);
        summary.appendChild(el('span', { className: 'admin-phase-progress' },
          parts.length ? parts.join(', ') : `${stage.totalCount} tasks`
        ));
        details.appendChild(summary);

        // Current stage cannot collapse
        if (stage.isCurrent) {
          details.addEventListener('toggle', () => { if (!details.open) details.setAttribute('open', ''); });
        }

        const list = el('div', { className: 'admin-task-list' });

        for (const task of stage.tasks) {
          if (!task) { console.warn('Undefined task entry in stage:', stage.id); continue; }
          const status  = task.status || 'pending';
          const isFuture = stage.isFuture;

          const iconEl = el('span', { className: `admin-task-icon status-${status}`, title: STATUS_TITLES[status] || '' },
            STATUS_ICONS[status] || '●');

          const stateLabel = (task.states || []).join('|');
          const stateBadge = el('span', {
            style: 'font-size:0.64rem;color:#9ca3af;background:#f3f4f6;border-radius:3px;' +
                   'padding:1px 4px;margin-left:5px;flex-shrink:0;font-weight:500',
          }, `[${stateLabel}]`);

          const itemCls = 'admin-task-item' + (
            status === 'completed' ? ' done'         :
            status === 'warning'   ? ' task-warning' :
            status === 'na'        ? ' task-na'      :
            isFuture               ? ' task-open'    : ''
          );
          const item = el('div', { className: itemCls }, iconEl,
            el('span', { style: 'flex:1' }, task.label), stateBadge);

          // Proceeding-type badge
          const pts = task.proceedingTypes || [];
          if (pts.length > 0) {
            const ptClass = pts.includes('trust') && !pts.includes('probate') ? 'trust'
              : pts.includes('probate') && !pts.includes('trust') ? 'probate'
              : pts.includes('testate') ? 'testate' : pts.includes('intestate') ? 'intestate' : 'probate';
            item.appendChild(el('span', { className: `task-pt-badge ${ptClass}` }, ptClass.toUpperCase()));
          }

          // Deadline tag
          const dk = task.deadline;
          const dl = dk ? deadlineByKey[dk] : null;
          if (dl && dl.daysUntil !== null) {
            item.appendChild(el('span', {
              className: 'admin-deadline-tag' +
                (dl.status === 'overdue' ? ' overdue' : dl.status === 'urgent' ? ' urgent' : ''),
            }, dl.dueDateDisplay));
          }

          // Generate-letter button (non-future tasks with autoGenerates)
          if (task.autoGenerates && !isFuture) {
            const genBtn = el('button', { className: 'admin-task-gen-btn', title: 'Generate letter' }, '✉');
            genBtn.addEventListener('click', e => {
              e.stopPropagation();
              const letter = ADMIN_LETTERS.find(l => l.id === task.autoGenerates);
              if (!letter) return;
              genBtn.disabled = true;
              apiFetch(`/api/admin/matter/${matterId}/letters/${letter.id}/generate`, {
                method: 'POST', body: JSON.stringify({ state: adminState.state }),
              }).then(d => showLetterModal(letter.label, d.text))
                .catch(err => alert('Letter error: ' + err.message))
                .finally(() => { genBtn.disabled = false; });
            });
            item.appendChild(genBtn);
          }

          // Click to cycle status — in-place DOM update, no re-render
          if (!isFuture) {
            item.style.cursor = 'pointer';
            item.addEventListener('click', () => {
              const curr = task.status;  // always read live status from task object
              const next = cycleStatus(curr);
              if (next === 'pending') delete adminState.tasks[task.id];
              else adminState.tasks[task.id] = next;
              apiFetch(`/api/admin/matter/${matterId}/task/${task.id}`, {
                method: 'POST', body: JSON.stringify({ status: next }),
              }).catch(() => {});
              task.status = next;

              // Update icon in-place
              const iconEl = item.querySelector('.admin-task-icon');
              if (iconEl) {
                iconEl.textContent = STATUS_ICONS[next] || '●';
                iconEl.className = `admin-task-icon status-${next}`;
                iconEl.title = STATUS_TITLES[next] || '';
              }
              // Update item class in-place
              item.className = 'admin-task-item' + (
                next === 'completed' ? ' done'         :
                next === 'warning'   ? ' task-warning' :
                next === 'na'        ? ' task-na'      : ''
              );
              item.style.cursor = 'pointer';

              // Recount stage and update summary progress text in-place
              const counts = { completed: 0, warning: 0, na: 0, pending: 0, open: 0 };
              for (const t of stage.tasks) { if (t) counts[t.status] = (counts[t.status] || 0) + 1; }
              Object.assign(stage, counts);
              const detailsEl = item.closest('details');
              const progressEl = detailsEl?.querySelector('.admin-phase-progress');
              if (progressEl) {
                const parts = [];
                if (stage.completed) parts.push(`${stage.completed} done`);
                if (stage.warning)   parts.push(`${stage.warning} ⚠`);
                if (stage.na)        parts.push(`${stage.na} N/A`);
                if ((stage.pending || 0) > 0 && !stage.isFuture) parts.push(`${stage.pending} pending`);
                progressEl.textContent = parts.length ? parts.join(', ') : `${stage.totalCount} tasks`;
              }
            });
          }

          list.appendChild(item);
        }
        details.appendChild(list);
        tasksDiv.appendChild(details);
      }
    }

    function loadTasks() {
      tasksLoaded = false;
      renderTasks();
      apiFetch(`/api/admin/matter/${matterId}/tasks/staged?state=${adminState.state}`)
        .then(data => {
          taskStages  = data.stages || [];
          tasksLoaded = true;
          renderTasks();
        })
        .catch(() => { tasksLoaded = true; renderTasks(); });
    }

    // ── Letter generator ──
    const lettersDiv = el('div', {});
    body.appendChild(lettersDiv);

    function showLetterModal(title, text) {
      const overlay = el('div', { className: 'admin-letter-modal-overlay' });
      const modal   = el('div', { className: 'admin-letter-modal' });

      const header = el('div', { className: 'admin-letter-modal-header' },
        el('span', { className: 'admin-letter-modal-title' }, title),
        el('button', { className: 'admin-letter-modal-close' }, '×')
      );
      header.querySelector('button').addEventListener('click', () => overlay.remove());

      const textarea = el('textarea', { className: 'admin-letter-textarea' }, text);

      const copyBtn = el('button', { className: 'admin-copy-btn' }, 'Copy to Clipboard');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(textarea.value).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 1500);
        });
      });

      const footer = el('div', { className: 'admin-letter-modal-footer' }, copyBtn);
      modal.appendChild(header);
      modal.appendChild(el('div', { className: 'admin-letter-modal-body' }, textarea));
      modal.appendChild(footer);
      overlay.appendChild(modal);
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }

    function renderLetters() {
      clearEl(lettersDiv);
      lettersDiv.appendChild(el('div', { className: 'admin-section-header' }, 'Letter Generator'));
      const box  = el('div', { className: 'admin-deadlines' });
      const list = el('div', { className: 'admin-letter-list' });

      for (const letter of ADMIN_LETTERS) {
        const btn = el('button', { className: 'admin-letter-btn' }, 'Generate');
        btn.addEventListener('click', () => {
          btn.disabled    = true;
          btn.textContent = '…';
          apiFetch(`/api/admin/matter/${matterId}/letters/${letter.id}/generate`, {
            method: 'POST',
            body: JSON.stringify({ state: adminState.state }),
          })
            .then(data => showLetterModal(letter.label, data.text))
            .catch(err => alert('Error: ' + err.message))
            .finally(() => { btn.disabled = false; btn.textContent = 'Generate'; });
        });

        list.appendChild(
          el('div', { className: 'admin-letter-row' },
            el('div', { className: 'admin-letter-info' },
              el('div', { className: 'admin-letter-title' }, letter.label),
              el('div', { className: 'admin-letter-desc'  }, letter.description)
            ),
            btn
          )
        );
      }
      box.appendChild(list);
      lettersDiv.appendChild(box);
    }

    // ── Add CSS for new deadline badge statuses (future, urgent, na) ──
    // (injected once per page since buildAdminUI may be called only once)
    if (!document.getElementById('admin-extra-styles')) {
      const s = document.createElement('style');
      s.id = 'admin-extra-styles';
      s.textContent = `
        .admin-deadline-badge.urgent  { background:#fff7ed;color:#c2410c; }
        .admin-deadline-badge.future  { background:#f3f4f6;color:#6b7280; }
        .admin-deadline-badge.na      { background:#f3f4f6;color:#9ca3af; }
        .admin-deadline-tag.overdue   { background:#fef2f2;color:#b91c1c; }
        .admin-deadline-tag.urgent    { background:#fff7ed;color:#c2410c; }

        /* Stage progress indicator */
        .admin-stage-indicator {
          display:flex; align-items:center; flex-wrap:nowrap; overflow-x:auto;
          padding:0.5rem 0 0.65rem; margin-bottom:0.25rem; gap:0;
          border-bottom:1px solid #e5e7eb;
        }
        .admin-stage-pill {
          display:flex; align-items:center; gap:0; padding:0.2rem 0.45rem;
          border-radius:4px; font-size:0.71rem; white-space:nowrap; font-weight:500;
        }
        .admin-stage-pill.current { background:#1e3a5f; color:#fff; }
        .admin-stage-pill.past    { color:#6b7280; }
        .admin-stage-pill.future  { color:#c9cdd4; }
        .admin-stage-arrow { color:#d1d5db; font-size:0.8rem; flex-shrink:0; padding:0 1px; }

        /* Stage-aware task styles */
        .admin-stage-section.stage-current > summary { background:#f0f4ff; border-left:3px solid #6366f1; }
        .admin-stage-section.stage-past    { opacity:0.75; }
        .admin-stage-section.stage-future  { opacity:0.6; }
        .admin-stage-summary { display:flex; align-items:center; gap:0.4rem; }
        .admin-task-icon { font-size:0.85rem; flex-shrink:0; line-height:1; }
        .admin-task-icon.status-completed { color:#16a34a; }
        .admin-task-icon.status-warning   { color:#d97706; }
        .admin-task-icon.status-na        { color:#9ca3af; }
        .admin-task-icon.status-pending   { color:#6366f1; }
        .admin-task-icon.status-open      { color:#d1d5db; }
        .admin-task-item.task-warning { background:#fffbeb; color:#92400e; }
        .admin-task-item.task-na      { color:#9ca3af; text-decoration:line-through; opacity:0.7; }
        .admin-task-item.task-open    { color:#d1d5db; cursor:default !important; }
        .admin-task-gen-btn {
          font-size:0.7rem; padding:1px 5px; border:1px solid #d1d5db; border-radius:3px;
          background:#f9fafb; cursor:pointer; flex-shrink:0; margin-left:4px;
        }
        .admin-task-gen-btn:hover { background:#e5e7eb; }

        /* Matter type confirmation modal */
        .mt-confirm-modal { font-size:0.875rem; }
        .mt-confirm-modal .change-row { display:flex; gap:0.5rem; align-items:baseline; margin:0.35rem 0; }
        .mt-confirm-modal .change-label { color:#6b7280; font-size:0.8rem; min-width:70px; }
        .mt-confirm-modal .change-value { font-weight:600; }
        .mt-testing-banner {
          background:#fef3c7; border:1px solid #fcd34d; border-radius:4px;
          padding:0.3rem 0.65rem; font-size:0.72rem; color:#92400e; margin-top:0.3rem;
        }
      `;
      document.head.appendChild(s);
    }

    // ── Load and render ──
    apiFetch(`/api/admin/matter/${matterId}`)
      .then(data => {
        adminState = { stage: 'PETITION_PREP', keyDates: {}, tasks: {}, ...data };
        // Derive state from saved type or overrides (detectedMatterType is in an outer scope, not accessible here)
        adminState.state = data.savedMatterType?.state || data.matterTypeOverrides?.state || 'MA';
        console.log('[Admin] matter state:', adminState.state,
          '| source:', data.savedMatterType?.state ? 'savedMatterType' :
            data.matterTypeOverrides?.state ? 'matterTypeOverrides' : 'default-MA');
        renderStageIndicator();
        renderDates();
        loadDeadlines();
        loadTasks();
        renderLetters();
      })
      .catch(() => {
        renderStageIndicator();
        renderDates();
        renderDeadlines();
        loadTasks();
        renderLetters();
      });

    // Initial UI while loading admin record
    renderStageIndicator();
    renderDates();
    renderDeadlines();
    renderTasks();
    renderLetters();

    container.appendChild(body);
  }

  // ── Audit Log View ────────────────────────────────────────────────────────

  let auditLogOffset = 0;
  const AUDIT_LOG_LIMIT = 50;
  let auditLogFilters = { matterId: '', userId: '', action: '' };

  function loadAuditLog(reset = true) {
    if (reset) auditLogOffset = 0;
    const container = document.getElementById('audit-log-container');
    if (!container) return;

    const { matterId, userId, action } = auditLogFilters;
    const params = new URLSearchParams({ limit: AUDIT_LOG_LIMIT, offset: auditLogOffset });
    if (matterId) params.set('matterId', matterId);
    if (userId)   params.set('userId', userId);
    if (action)   params.set('action', action);

    apiFetch('/api/audit-log?' + params.toString())
      .then(data => renderAuditLog(data.events || [], data.total || 0))
      .catch(err => {
        container.innerHTML = `<div style="color:#ef4444;padding:1rem">Error: ${err.message}</div>`;
      });
  }

  function renderAuditLog(events, total) {
    const container = document.getElementById('audit-log-container');
    if (!container) return;

    if (events.length === 0 && auditLogOffset === 0) {
      container.innerHTML = '<div style="color:#9ca3af;padding:1rem 0;font-size:0.85rem">No audit events found.</div>';
      return;
    }

    const rows = events.map(e => {
      const ts = new Date(e.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      const detail = [e.detail, e.previousValue && e.newValue ? `${e.previousValue} → ${e.newValue}` : ''].filter(Boolean).join(' | ');
      return `<tr>
        <td style="white-space:nowrap;color:#6b7280;font-size:0.75rem">${ts}</td>
        <td style="font-size:0.8rem;font-weight:500">${escapeHtml(e.userName || '')}</td>
        <td style="font-size:0.75rem"><span style="background:#f3f4f6;border-radius:3px;padding:1px 5px;font-family:monospace">${escapeHtml(e.action || '')}</span></td>
        <td style="font-size:0.8rem;color:#374151">${escapeHtml(e.matterName || '—')}</td>
        <td style="font-size:0.78rem;color:#6b7280">${escapeHtml(detail || '—')}</td>
      </tr>`;
    }).join('');

    const pagination = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:0.75rem;font-size:0.8rem;color:#6b7280">
        <span>Showing ${auditLogOffset + 1}–${Math.min(auditLogOffset + events.length, total)} of ${total} events</span>
        <div style="display:flex;gap:0.5rem">
          ${auditLogOffset > 0 ? '<button onclick="window._auditPrev()" style="padding:3px 10px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;background:#fff">← Prev</button>' : ''}
          ${auditLogOffset + events.length < total ? '<button onclick="window._auditNext()" style="padding:3px 10px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;background:#fff">Next →</button>' : ''}
        </div>
      </div>`;

    container.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
          <thead><tr style="border-bottom:2px solid #e5e7eb;text-align:left">
            <th style="padding:6px 8px;font-size:0.75rem;color:#6b7280;font-weight:600">Time</th>
            <th style="padding:6px 8px;font-size:0.75rem;color:#6b7280;font-weight:600">User</th>
            <th style="padding:6px 8px;font-size:0.75rem;color:#6b7280;font-weight:600">Action</th>
            <th style="padding:6px 8px;font-size:0.75rem;color:#6b7280;font-weight:600">Matter</th>
            <th style="padding:6px 8px;font-size:0.75rem;color:#6b7280;font-weight:600">Detail</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${pagination}`;

    window._auditPrev = () => { auditLogOffset = Math.max(0, auditLogOffset - AUDIT_LOG_LIMIT); loadAuditLog(false); };
    window._auditNext = () => { auditLogOffset += AUDIT_LOG_LIMIT; loadAuditLog(false); };
  }

  function exportAuditCsv() {
    const params = new URLSearchParams({ limit: 10000, offset: 0, ...auditLogFilters });
    apiFetch('/api/audit-log?' + params.toString()).then(data => {
      const rows = [['Timestamp','User','Role','Action','Matter','Detail','Previous','New']];
      for (const e of data.events || []) {
        rows.push([e.timestamp, e.userName, e.userRole, e.action, e.matterName || '', e.detail || '', e.previousValue || '', e.newValue || '']);
      }
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = `audit-log-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    }).catch(err => alert('Export error: ' + err.message));
  }

})();
