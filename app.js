/* OHMY Dev Tracker — read-only board. No framework, no build, no server. */
(() => {
  'use strict';

  const data = window.TRACKER;
  const $ = (id) => document.getElementById(id);

  if (!data || !Array.isArray(data.rows)) {
    document.body.innerHTML =
      '<p style="padding:40px;font:14px system-ui">data/tracker.js is missing or empty. ' +
      'Run <code>update.bat</code> (or <code>npm run build</code>) to generate it from the Excel file.</p>';
    return;
  }

  const ROWS = data.rows;

  /* ---------------------------------------------------------------- helpers */
  const STATUS_CLASS = {
    Live: 'live',
    'In Development': 'dev',
    Testing: 'test',
    'NDA/Contract': 'nda',
    Contact: 'contact',
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  };

  const daysClass = (row) => {
    if (row.health === 'live') return 'live';
    if (row.days === null) return 'never';
    if (row.days > 90) return 'd90';
    if (row.days > 30) return 'd30';
    if (row.days > 14) return 'd14';
    return 'ok';
  };

  const daysText = (row) => (row.days === null ? 'never' : `${row.days}d`);

  const escape = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const NEEDS_ATTENTION = new Set(['norecord', 'stalled90', 'stalled30', 'watch']);

  /* ---------------------------------------------------------------- state */
  const state = {
    q: '',
    status: '',
    category: '',
    pic: '',
    health: '',
    sort: 'attention',
    dir: 'asc',
    open: new Set(),
  };

  /* ---------------------------------------------------------------- header */
  const counts = data.counts ?? {};
  const generated = new Date(data.generatedAt);
  $('meta').innerHTML =
    `<b>${ROWS.length}</b> projects · built ${escape(
      generated.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    )} · source <b>${escape(data.sourceFile)}</b> / ${escape(data.sourceSheet)}`;

  /* ---------------------------------------------------------------- tiles */
  const byStatus = counts.byStatus ?? {};
  const byHealth = counts.byHealth ?? {};
  const attention = ROWS.filter((r) => NEEDS_ATTENTION.has(r.health)).length;

  const TILES = [
    { key: 'all', label: 'All projects', value: ROWS.length, filter: {} },
    { key: 'live', label: 'Live', value: byStatus.Live ?? 0, filter: { status: 'Live' }, tone: 'good' },
    { key: 'dev', label: 'In development', value: byStatus['In Development'] ?? 0, filter: { status: 'In Development' } },
    { key: 'nda', label: 'NDA / contract', value: byStatus['NDA/Contract'] ?? 0, filter: { status: 'NDA/Contract' } },
    { key: 'contact', label: 'Contact', value: byStatus.Contact ?? 0, filter: { status: 'Contact' } },
    { key: 'attention', label: 'Needs attention', value: attention, filter: { health: 'attention' }, tone: 'alert' },
    { key: 'stalled90', label: 'Stalled 90d+', value: byHealth.stalled90 ?? 0, filter: { health: 'stalled90' }, tone: 'alert' },
    { key: 'norecord', label: 'No activity record', value: byHealth.norecord ?? 0, filter: { health: 'norecord' }, tone: 'alert' },
  ];

  $('tiles').innerHTML = TILES.map(
    (t) =>
      `<button type="button" class="tile ${t.tone ?? ''}" data-tile="${t.key}" aria-pressed="false">
         <span class="k">${escape(t.label)}</span><span class="v">${t.value}</span>
       </button>`,
  ).join('');

  $('tiles').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tile]');
    if (!button) return;
    const tile = TILES.find((t) => t.key === button.dataset.tile);
    if (!tile) return;
    const already = button.getAttribute('aria-pressed') === 'true';
    state.status = '';
    state.health = '';
    if (!already) Object.assign(state, tile.filter);
    syncControls();
    render();
  });

  /* ---------------------------------------------------------------- filter options */
  const options = (id, values, label) => {
    const select = $(id);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.dataset.empty = 'true';
    select.setAttribute('aria-label', label);
  };

  const uniqueSorted = (key) =>
    [...new Set(ROWS.map((r) => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  options('f-status', uniqueSorted('status'), 'Status');
  options('f-category', uniqueSorted('category'), 'Category');
  options('f-pic', uniqueSorted('pic'), 'PIC');
  $('f-health').dataset.empty = 'true';

  /* ---------------------------------------------------------------- filtering */
  function visibleRows() {
    const q = state.q.trim().toLowerCase();

    const filtered = ROWS.filter((row) => {
      if (state.status && row.status !== state.status) return false;
      if (state.category && row.category !== state.category) return false;
      if (state.pic && row.pic !== state.pic) return false;
      if (state.health) {
        if (state.health === 'attention') {
          if (!NEEDS_ATTENTION.has(row.health)) return false;
        } else if (row.health !== state.health) return false;
      }
      if (q) {
        const hay = [row.project, row.category, row.status, row.pic, row.team, row.switching, row.currentStage]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const key = state.sort;
    const sign = state.dir === 'asc' ? 1 : -1;

    // Default order: what needs a human first. Severity band, then how far along the
    // integration is (more invested = more at stake), then how long it has been quiet.
    if (key === 'attention') {
      return filtered.sort(
        (a, b) => a.rank - b.rank || b.progress - a.progress || (b.days ?? 0) - (a.days ?? 0),
      );
    }

    return filtered.sort((a, b) => {
      let x = a[key];
      let y = b[key];

      // Nulls always sort last, whichever direction is active.
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;

      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      x = String(x).toLowerCase();
      y = String(y).toLowerCase();
      return x < y ? -sign : x > y ? sign : 0;
    });
  }

  /* ---------------------------------------------------------------- render */
  function rowHtml(row) {
    const statusClass = STATUS_CLASS[row.status] ?? 'contact';
    const track = row.stages
      .map(
        (s) =>
          `<span class="step ${s.date ? 'hit' : ''} ${s.date && s.n === 11 ? 'final' : ''}" title="${escape(s.label)}${
            s.date ? ` · ${fmtDate(s.date)}` : ' · not reached'
          }">${s.n}</span>`,
      )
      .join('');

    return `
      <tr class="row ${state.open.has(row.no) ? 'open' : ''}" data-no="${row.no}">
        <td class="num">${escape(row.no)}</td>
        <td class="partner">${escape(row.project)}${row.impact === 'High' ? '<span class="flag">HIGH</span>' : ''}</td>
        <td class="dim">${escape(row.category)}</td>
        <td><span class="chip ${statusClass}">${escape(row.status)}</span></td>
        <td>
          <span class="progress">
            <span class="bar ${row.progress === 100 ? 'done' : ''}"><span style="width:${row.progress}%"></span></span>
            <span class="pct">${row.progress}%</span>
          </span>
        </td>
        <td class="track-cell"><span class="track">${track}</span></td>
        <td>${row.pic ? escape(row.pic) : '<span class="faint">—</span>'}</td>
        <td class="c-team dim">${row.team ? escape(row.team) : '—'}</td>
        <td><span class="load ${row.devLoad}"><span class="dot"></span>${escape(row.devLoadLabel)}</span></td>
        <td class="c-switching dim">${row.switching ? escape(row.switching) : '—'}</td>
        <td class="dim">${fmtDate(row.lastActivity)}</td>
        <td class="num"><span class="days ${daysClass(row)}">${daysText(row)}</span></td>
      </tr>`;
  }

  function detailHtml(row) {
    const stages = row.stages
      .map(
        (s) => `
        <div class="stagerow ${s.date ? 'hit' : 'miss'} ${s.date && s.n === 11 ? 'final' : ''}">
          <span class="n">${String(s.n).padStart(2, '0')}</span>
          <span class="l">${escape(s.label)}</span>
          <span class="d">${s.date ? fmtDate(s.date) : '—'}</span>
        </div>`,
      )
      .join('');

    const notes = [
      row.currentStage ? `Furthest stage reached: <b>${escape(row.currentStage)}</b>` : 'No stage date recorded yet.',
      row.delayNote ? `Sheet delay note: <b>${escape(row.delayNote)}</b>` : null,
      row.lastActivity
        ? `Last activity <b>${fmtDate(row.lastActivity)}</b> (${row.days} days ago)`
        : 'Last activity <b>never recorded</b>',
    ]
      .filter(Boolean)
      .join(' &nbsp;·&nbsp; ');

    return `
      <tr class="detail" data-detail="${row.no}">
        <td colspan="12">
          <div class="detail-inner">
            <div class="detail-title">${escape(row.project)} — stage history</div>
            <div class="stagelist">${stages}</div>
            <p class="notes">${notes}</p>
          </div>
        </td>
      </tr>`;
  }

  function render() {
    const rows = visibleRows();

    $('tbody').innerHTML = rows
      .map((row) => rowHtml(row) + (state.open.has(row.no) ? detailHtml(row) : ''))
      .join('');

    $('empty').hidden = rows.length > 0;

    const attentionShown = rows.filter((r) => NEEDS_ATTENTION.has(r.health)).length;
    const scope = rows.length === ROWS.length ? `${rows.length} projects` : `${rows.length} of ${ROWS.length} projects`;
    const order =
      state.sort === 'attention'
        ? 'sorted by attention — most stuck first, finished ones last'
        : `sorted by ${state.sort} (${state.dir})`;
    $('resultline').textContent = `${scope} · ${attentionShown} need attention · ${order}`;

    for (const th of document.querySelectorAll('th.sortable')) {
      if (th.dataset.sort === state.sort) th.dataset.dir = state.dir;
      else delete th.dataset.dir;
    }

    for (const tile of document.querySelectorAll('[data-tile]')) {
      const t = TILES.find((x) => x.key === tile.dataset.tile);
      const active =
        t.key === 'all'
          ? !state.status && !state.health
          : (t.filter.status ?? '') === state.status && (t.filter.health ?? '') === state.health && (t.filter.status || t.filter.health);
      tile.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function syncControls() {
    $('search').value = state.q;
    $('f-status').value = state.status;
    $('f-category').value = state.category;
    $('f-pic').value = state.pic;
    $('f-health').value = state.health;
    for (const id of ['f-status', 'f-category', 'f-pic', 'f-health']) {
      $(id).dataset.empty = $(id).value === '' ? 'true' : 'false';
    }
  }

  /* ---------------------------------------------------------------- events */
  $('search').addEventListener('input', (e) => {
    state.q = e.target.value;
    render();
  });

  for (const [id, key] of [
    ['f-status', 'status'],
    ['f-category', 'category'],
    ['f-pic', 'pic'],
    ['f-health', 'health'],
  ]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.value;
      e.target.dataset.empty = e.target.value === '' ? 'true' : 'false';
      render();
    });
  }

  document.querySelector('thead').addEventListener('click', (event) => {
    const th = event.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      // Numbers read best largest-first; text reads best A-Z.
      state.dir = ['days', 'progress', 'no'].includes(key) ? 'desc' : 'asc';
    }
    render();
  });

  $('tbody').addEventListener('click', (event) => {
    const tr = event.target.closest('tr.row');
    if (!tr) return;
    const no = Number(tr.dataset.no);
    if (state.open.has(no)) state.open.delete(no);
    else state.open.add(no);
    render();
  });

  $('reset').addEventListener('click', () => {
    Object.assign(state, { q: '', status: '', category: '', pic: '', health: '', sort: 'attention', dir: 'asc' });
    state.open.clear();
    syncControls();
    render();
  });

  $('export').addEventListener('click', () => {
    const header = [
      'No', 'Project', 'Category', 'Status', 'Progress %', 'Current stage', 'Biz impact',
      'PIC', 'Team', 'Dev load', 'Switching', 'Last activity', 'Days since', 'Health',
    ];
    const cell = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = visibleRows().map((r) =>
      [r.no, r.project, r.category, r.status, r.progress, r.currentStage ?? '', r.impact ?? '',
       r.pic ?? '', r.team ?? '', r.devLoadLabel, r.switching ?? '', r.lastActivity ?? '',
       r.days ?? '', r.health].map(cell).join(','),
    );
    // BOM so Excel opens the UTF-8 partner names correctly.
    const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dev-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('search').focus();
      $('search').select();
    } else if (event.key === 'Escape') {
      if (state.q) {
        state.q = '';
        syncControls();
        render();
      }
      $('search').blur();
    }
  });

  syncControls();
  render();
})();
