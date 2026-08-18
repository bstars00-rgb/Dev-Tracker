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
  const STAGE_MODEL = data.stageModel ?? [];

  /* ================================================================ helpers */
  const STATUS_CLASS = {
    Live: 'live',
    'In Development': 'dev',
    Testing: 'test',
    'NDA/Contract': 'nda',
    Contact: 'contact',
  };

  const escape = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

  const NEEDS_ATTENTION = new Set(['norecord', 'stalled90', 'stalled30', 'watch']);
  const needsAttention = (row) => NEEDS_ATTENTION.has(row.health);
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  /* ================================================================ state */
  const state = {
    tab: 'dashboard',
    q: '',
    status: '',
    category: '',
    pic: '',
    health: '',
    stageAt: '', // weight of the stage a project is currently parked on
    sort: 'attention',
    dir: 'asc',
    open: new Set(),
  };

  /* ================================================================ header */
  const generated = new Date(data.generatedAt);
  $('meta').innerHTML =
    `<b>${ROWS.length}</b> projects · built ${escape(
      generated.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    )} · source <b>${escape(data.sourceFile)}</b> / ${escape(data.sourceSheet)}`;

  /* ================================================================ tabs */
  function showTab(tab) {
    state.tab = tab;
    $('view-dashboard').hidden = tab !== 'dashboard';
    $('view-list').hidden = tab !== 'list';
    for (const button of $('tabs').children) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
    window.scrollTo({ top: 0 });
  }

  $('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  });

  /** Jump from any dashboard element into the list with a filter already applied. */
  function drillTo(filters) {
    Object.assign(state, { q: '', status: '', category: '', pic: '', health: '', stageAt: '' }, filters);
    syncControls();
    renderList();
    showTab('list');
  }

  /* ================================================================ dashboard */
  function renderDashboard() {
    const total = ROWS.length;
    const live = ROWS.filter((r) => r.status === 'Live').length;
    const contact = ROWS.filter((r) => r.progress === 0).length;
    const inFlight = total - live - contact;
    const attention = ROWS.filter(needsAttention).length;
    const stalled90 = ROWS.filter((r) => r.health === 'stalled90').length;
    const norecord = ROWS.filter((r) => r.health === 'norecord').length;

    /* ---- KPI cards ------------------------------------------------ */
    const KPIS = [
      { label: 'Total', value: total, sub: `${data.sourceSheet} 시트 전체`, filters: {} },
      { label: 'Live', value: live, sub: `전체의 ${pct(live, total)}% 완료`, tone: 'good', filters: { status: 'Live' } },
      { label: 'In flight', value: inFlight, sub: 'NDA ~ Live Open 사이', tone: 'info', filters: { health: '', status: '' }, custom: 'inflight' },
      { label: 'First contact', value: contact, sub: '아직 NDA 전', filters: { status: 'Contact' } },
      { label: 'Needs attention', value: attention, sub: attention === total - live ? `미완료 ${attention}건 전부` : `미완료 ${total - live}건 중 ${attention}건`, tone: 'alert', filters: { health: 'attention' } },
      { label: 'Stalled 90d+', value: stalled90, sub: '3개월 이상 무소식', tone: 'alert', filters: { health: 'stalled90' } },
      { label: 'No activity record', value: norecord, sub: '기록 자체가 없음', tone: 'alert', filters: { health: 'norecord' } },
    ];

    $('kpis').innerHTML = KPIS.map(
      (k, i) => `
      <button type="button" class="kpi ${k.tone ?? ''}" data-kpi="${i}">
        <span class="kpi-label">${escape(k.label)}</span>
        <span class="kpi-value">${k.value}</span>
        <span class="kpi-sub">${escape(k.sub)}</span>
      </button>`,
    ).join('');

    $('kpis').onclick = (event) => {
      const button = event.target.closest('[data-kpi]');
      if (!button) return;
      const kpi = KPIS[Number(button.dataset.kpi)];
      if (kpi.custom === 'inflight') {
        // No single filter expresses "started but not finished", so search is left open
        // and the two end states are excluded by sorting attention-first instead.
        drillTo({ health: 'attention' });
        return;
      }
      drillTo(kpi.filters);
    };

    /* ---- stage funnel --------------------------------------------- */
    // reached = progress >= that stage's weight. parked = sitting exactly there.
    const steps = [{ n: 0, label: 'Contact', weight: 0 }, ...STAGE_MODEL];
    const funnel = steps.map((s) => ({
      ...s,
      reached: ROWS.filter((r) => r.progress >= s.weight).length,
      parked: ROWS.filter((r) => r.progress === s.weight).length,
    }));

    $('funnel').innerHTML = funnel
      .map((s, i) => {
        const drop = i === 0 ? 0 : funnel[i - 1].reached - s.reached;
        const parkedAttention = ROWS.filter((r) => r.progress === s.weight && needsAttention(r)).length;
        return `
        <button type="button" class="funnel-row" data-stage="${s.weight}" ${s.parked === 0 ? 'disabled' : ''}
                title="${escape(s.label)} 단계 ${s.parked}건 보기">
          <span class="f-label">${escape(s.label)}</span>
          <span class="f-weight">${s.weight}%</span>
          <span class="f-bar"><span style="width:${pct(s.reached, ROWS.length)}%"></span></span>
          <span class="f-reached">${s.reached}</span>
          <span class="f-drop">${drop > 0 ? `−${drop}` : ''}</span>
          <span class="f-parked ${parkedAttention > 0 ? 'warn' : ''}">${parkedLabel(s, parkedAttention)}</span>
        </button>`;
      })
      .join('');

    function parkedLabel(step, atRisk) {
      if (step.parked === 0) return '';
      if (step.weight === 100) return `${step.parked}건 완료`;
      if (atRisk === 0) return `${step.parked}건 대기`;
      if (atRisk === step.parked) return `${step.parked}건 대기 · 전부 위험`;
      return `${step.parked}건 대기 · ${atRisk} 위험`;
    }

    $('funnel').onclick = (event) => {
      const button = event.target.closest('[data-stage]');
      if (button && !button.disabled) drillTo({ stageAt: button.dataset.stage });
    };

    /* ---- breakdowns ------------------------------------------------ */
    renderBreakdown('by-pic', 'pic', (value) => ({ pic: value }), '담당자 없음');
    renderBreakdown('by-category', 'category', (value) => ({ category: value }), '미분류');

    /* ---- aging ------------------------------------------------------ */
    const open = ROWS.filter((r) => r.status !== 'Live');
    const BUCKETS = [
      { key: 'ok', label: '14일 이내', test: (r) => r.days !== null && r.days <= 14, health: '' },
      { key: 'watch', label: '15 – 30일', test: (r) => r.days !== null && r.days > 14 && r.days <= 30, health: 'watch' },
      { key: 'd30', label: '31 – 90일', test: (r) => r.days !== null && r.days > 30 && r.days <= 90, health: 'stalled30' },
      { key: 'd90', label: '90일 초과', test: (r) => r.days !== null && r.days > 90, health: 'stalled90' },
      { key: 'never', label: '기록 없음', test: (r) => r.days === null, health: 'norecord' },
    ];
    const maxBucket = Math.max(1, ...BUCKETS.map((b) => open.filter(b.test).length));

    $('by-aging').innerHTML = BUCKETS.map((b) => {
      const count = open.filter(b.test).length;
      return `
        <button type="button" class="bd-row" data-health="${b.health}" ${count === 0 ? 'disabled' : ''}>
          <span class="bd-label">${escape(b.label)}</span>
          <span class="bd-bar"><span class="seg ${b.key}" style="width:${pct(count, maxBucket)}%"></span></span>
          <span class="bd-count">${count}</span>
        </button>`;
    }).join('') +
      `<p class="bd-foot">완료(Live) ${ROWS.length - open.length}건은 제외. 진행 중 ${open.length}건 기준.</p>`;

    $('by-aging').onclick = (event) => {
      const button = event.target.closest('[data-health]');
      if (button && !button.disabled) drillTo({ health: button.dataset.health });
    };

    /* ---- top attention --------------------------------------------- */
    const top = [...ROWS]
      .filter(needsAttention)
      .sort((a, b) => a.rank - b.rank || b.progress - a.progress || (b.days ?? 0) - (a.days ?? 0))
      .slice(0, 10);

    $('top-attention').innerHTML = top.length
      ? top
          .map(
            (r) => `
        <li>
          <button type="button" class="top-row" data-project="${escape(r.project)}">
            <span class="t-name">${escape(r.project)}${r.impact === 'High' ? '<span class="flag">HIGH</span>' : ''}</span>
            <span class="t-stage">${escape(r.currentStage ?? 'Contact')}</span>
            <span class="t-pic">${escape(r.pic ?? '—')}</span>
            <span class="t-days ${daysClass(r)}">${daysText(r)}</span>
          </button>
        </li>`,
          )
          .join('')
      : '<li class="bd-foot">손봐야 할 건이 없습니다.</li>';

    $('top-attention').onclick = (event) => {
      const button = event.target.closest('[data-project]');
      if (button) drillTo({ q: button.dataset.project });
    };
  }

  function renderBreakdown(elementId, key, filterFor, emptyLabel) {
    const groups = new Map();
    for (const row of ROWS) {
      const value = row[key] ?? '';
      const entry = groups.get(value) ?? { total: 0, attention: 0, live: 0 };
      entry.total += 1;
      if (needsAttention(row)) entry.attention += 1;
      if (row.status === 'Live') entry.live += 1;
      groups.set(value, entry);
    }

    const sorted = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
    const max = Math.max(1, ...sorted.map(([, v]) => v.total));

    $(elementId).innerHTML = sorted
      .map(
        ([value, v]) => `
      <button type="button" class="bd-row" data-value="${escape(value)}">
        <span class="bd-label">${escape(value || emptyLabel)}</span>
        <span class="bd-bar" title="${v.live} live · ${v.attention} 위험 · ${v.total - v.live - v.attention} 정상">
          <span class="seg live" style="width:${pct(v.live, max)}%"></span>
          <span class="seg risk" style="width:${pct(v.attention, max)}%"></span>
          <span class="seg rest" style="width:${pct(v.total - v.live - v.attention, max)}%"></span>
        </span>
        <span class="bd-count">${v.total}<em>${v.attention ? ` · ${v.attention}` : ''}</em></span>
      </button>`,
      )
      .join('') +
      `<p class="bd-foot"><span class="key live"></span> Live &nbsp; <span class="key risk"></span> 손이 필요함 &nbsp; <span class="key rest"></span> 그 외</p>`;

    $(elementId).onclick = (event) => {
      const button = event.target.closest('[data-value]');
      if (button) drillTo(filterFor(button.dataset.value));
    };
  }

  /* ================================================================ list */
  const options = (id, values) => {
    const select = $(id);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.dataset.empty = 'true';
  };

  const uniqueSorted = (key) =>
    [...new Set(ROWS.map((r) => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  options('f-status', uniqueSorted('status'));
  options('f-category', uniqueSorted('category'));
  options('f-pic', uniqueSorted('pic'));
  $('f-health').dataset.empty = 'true';

  function visibleRows() {
    const q = state.q.trim().toLowerCase();

    const filtered = ROWS.filter((row) => {
      if (state.status && row.status !== state.status) return false;
      if (state.category && row.category !== state.category) return false;
      if (state.pic && row.pic !== state.pic) return false;
      if (state.stageAt !== '' && row.progress !== Number(state.stageAt)) return false;
      if (state.health) {
        if (state.health === 'attention') {
          if (!needsAttention(row)) return false;
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
      return filtered.sort((a, b) => a.rank - b.rank || b.progress - a.progress || (b.days ?? 0) - (a.days ?? 0));
    }

    return filtered.sort((a, b) => {
      let x = a[key];
      let y = b[key];
      if (x === null || x === undefined) return 1; // nulls last, either direction
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      x = String(x).toLowerCase();
      y = String(y).toLowerCase();
      return x < y ? -sign : x > y ? sign : 0;
    });
  }

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

  function renderList() {
    const rows = visibleRows();

    $('tbody').innerHTML = rows.map((row) => rowHtml(row) + (state.open.has(row.no) ? detailHtml(row) : '')).join('');
    $('empty').hidden = rows.length > 0;

    const shown = rows.filter(needsAttention).length;
    const scope = rows.length === ROWS.length ? `${rows.length} projects` : `${rows.length} of ${ROWS.length} projects`;
    const order =
      state.sort === 'attention'
        ? 'sorted by attention — most stuck first, finished ones last'
        : `sorted by ${state.sort} (${state.dir})`;
    $('resultline').textContent = `${scope} · ${shown} need attention · ${order}`;

    for (const th of document.querySelectorAll('th.sortable')) {
      if (th.dataset.sort === state.sort) th.dataset.dir = state.dir;
      else delete th.dataset.dir;
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

    // The stage filter has no dropdown — it only arrives from the funnel, so it shows
    // as a removable chip instead of silently narrowing the table.
    const chip = $('f-stage');
    if (state.stageAt === '') {
      chip.hidden = true;
    } else {
      const step = [{ label: 'Contact', weight: 0 }, ...STAGE_MODEL].find((s) => s.weight === Number(state.stageAt));
      chip.hidden = false;
      chip.textContent = `Stage: ${step ? step.label : `${state.stageAt}%`}  ✕`;
    }
  }

  /* ================================================================ events */
  $('search').addEventListener('input', (e) => {
    state.q = e.target.value;
    renderList();
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
      renderList();
    });
  }

  $('f-stage').addEventListener('click', () => {
    state.stageAt = '';
    syncControls();
    renderList();
  });

  document.querySelector('thead').addEventListener('click', (event) => {
    const th = event.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      state.dir = ['days', 'progress', 'no'].includes(key) ? 'desc' : 'asc'; // numbers read best largest-first
    }
    renderList();
  });

  $('tbody').addEventListener('click', (event) => {
    const tr = event.target.closest('tr.row');
    if (!tr) return;
    const no = Number(tr.dataset.no);
    if (state.open.has(no)) state.open.delete(no);
    else state.open.add(no);
    renderList();
  });

  $('reset').addEventListener('click', () => {
    Object.assign(state, { q: '', status: '', category: '', pic: '', health: '', stageAt: '', sort: 'attention', dir: 'asc' });
    state.open.clear();
    syncControls();
    renderList();
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
      showTab('list');
      $('search').focus();
      $('search').select();
    } else if (event.key === 'Escape') {
      if (state.q) {
        state.q = '';
        syncControls();
        renderList();
      }
      $('search').blur();
    }
  });

  /* ================================================================ boot */
  renderDashboard();
  syncControls();
  renderList();
  showTab(location.hash.slice(1) === 'list' ? 'list' : 'dashboard');
})();
