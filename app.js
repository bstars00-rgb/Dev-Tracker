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
  const STEPS = [{ n: 0, label: 'Contact', weight: 0 }, ...STAGE_MODEL];

  /* ================================================================ i18n */
  const PACKS = window.I18N ?? { ko: {}, en: {} };
  const saved = localStorage.getItem('ict-lang');
  let lang = saved || ((navigator.language || '').startsWith('ko') ? 'ko' : 'en');

  /** Look up a string and fill {placeholders}. Falls back to the key, so a missing
      translation shows up rather than silently rendering blank. */
  function t(key, vars) {
    let text = PACKS[lang]?.[key] ?? PACKS.en?.[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  }

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

  const locale = () => (lang === 'ko' ? 'ko-KR' : 'en-GB');

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
  };

  const daysClass = (row) => {
    if (row.health === 'live') return 'live';
    if (row.days === null) return 'never';
    if (row.days > 90) return 'd90';
    if (row.days > 30) return 'd30';
    if (row.days > 14) return 'd14';
    return 'ok';
  };

  const daysText = (row) => (row.days === null ? t('value.never') : `${row.days}d`);

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
    stageAt: '',
    health: '',
    impact: '',
    sort: 'attention',
    dir: 'asc',
    open: new Set(),
  };

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
    Object.assign(state, { q: '', status: '', category: '', pic: '', stageAt: '', health: '', impact: '' }, filters);
    syncControls();
    renderList();
    showTab('list');
  }

  /* ================================================================ derived facts */
  /** Days from the first recorded stage date to the 100% date, for finished projects. */
  function averageDaysToLive() {
    const spans = ROWS.filter((r) => r.progress === 100)
      .map((r) => {
        const dates = r.stages.filter((s) => s.date).map((s) => Date.parse(`${s.date}T00:00:00Z`));
        const end = r.stages.find((s) => s.n === 11 && s.date);
        if (dates.length < 2 || !end) return null;
        const span = Date.parse(`${end.date}T00:00:00Z`) - Math.min(...dates);
        return span > 0 ? Math.round(span / 86_400_000) : null;
      })
      .filter((v) => v !== null);
    return spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
  }

  const quietest = (rows) => rows.filter((r) => r.days !== null).sort((a, b) => b.days - a.days)[0] ?? null;

  /* ================================================================ cards */
  function renderCards() {
    const total = ROWS.length;
    const live = ROWS.filter((r) => r.status === 'Live');
    const contact = ROWS.filter((r) => r.progress === 0);
    const inFlight = ROWS.filter((r) => r.progress > 0 && r.status !== 'Live');
    const attention = ROWS.filter(needsAttention);
    const stalled90 = ROWS.filter((r) => r.health === 'stalled90');
    const norecord = ROWS.filter((r) => r.health === 'norecord');
    const highImpact = ROWS.filter((r) => r.impact === 'High');

    const statusCounts = [...new Set(ROWS.map((r) => r.status))]
      .map((s) => ({ status: s, n: ROWS.filter((r) => r.status === s).length }))
      .sort((a, b) => b.n - a.n);

    const avgDays = averageDaysToLive();
    const furthest = inFlight.length ? inFlight.reduce((a, b) => (b.progress > a.progress ? b : a)) : null;
    const worstAttention = quietest(attention);
    const worstStalled = quietest(stalled90);
    const norecordNoPic = norecord.filter((r) => !r.pic).length;
    const impactAtRisk = highImpact.filter(needsAttention).length;

    // Each card carries four things: the number, its share of the portfolio, a
    // composition bar, and one sentence that says what the number alone does not.
    const CARDS = [
      {
        label: t('card.total'),
        value: total,
        segments: [
          { key: 'live', n: live.length, label: t('card.seg.live') },
          { key: 'rest', n: inFlight.length, label: t('card.seg.inflight') },
          { key: 'idle', n: contact.length, label: t('card.seg.contact') },
        ],
        note: statusCounts.length ? t('card.total.note', { status: statusCounts[0].status, n: statusCounts[0].n }) : '',
        filters: {},
      },
      {
        label: t('card.live'),
        value: live.length,
        tone: 'good',
        aux: t('card.share', { n: pct(live.length, total) }),
        segments: [
          { key: 'live', n: live.length, label: t('card.seg.live') },
          { key: 'idle', n: total - live.length, label: '—' },
        ],
        note: avgDays === null ? t('card.live.note.none') : t('card.live.note', { n: avgDays }),
        filters: { status: 'Live' },
      },
      {
        label: t('card.inflight'),
        value: inFlight.length,
        tone: 'info',
        aux: t('card.share', { n: pct(inFlight.length, total) }),
        segments: [
          { key: 'risk', n: inFlight.filter(needsAttention).length, label: t('card.seg.risk') },
          { key: 'ok', n: inFlight.filter((r) => !needsAttention(r)).length, label: t('card.seg.ok') },
          { key: 'idle', n: total - inFlight.length, label: '—' },
        ],
        note: furthest ? t('card.inflight.note', { stage: furthest.currentStage ?? '—' }) : t('card.inflight.note.none'),
        filters: { health: 'attention' },
      },
      {
        label: t('card.contact'),
        value: contact.length,
        aux: t('card.share', { n: pct(contact.length, total) }),
        segments: [
          { key: 'idle', n: contact.length, label: t('card.seg.contact') },
          { key: 'rest', n: total - contact.length, label: '—' },
        ],
        note: t('card.contact.note', { n: pct(contact.length, total) }),
        filters: { status: 'Contact' },
      },
      {
        label: t('card.attention'),
        value: attention.length,
        tone: 'alert',
        aux: t('card.share', { n: pct(attention.length, total) }),
        segments: [
          { key: 'watch', n: ROWS.filter((r) => r.health === 'watch').length, label: t('card.seg.watch') },
          { key: 'd30', n: ROWS.filter((r) => r.health === 'stalled30').length, label: t('card.seg.d30') },
          { key: 'd90', n: stalled90.length, label: t('card.seg.d90') },
          { key: 'never', n: norecord.length, label: t('card.seg.never') },
        ],
        note: worstAttention
          ? t('card.attention.note', { name: worstAttention.project, n: worstAttention.days })
          : t('card.attention.note.none'),
        filters: { health: 'attention' },
      },
      {
        label: t('card.stalled90'),
        value: stalled90.length,
        tone: 'alert',
        aux: t('card.share', { n: pct(stalled90.length, total) }),
        segments: [
          { key: 'd90', n: stalled90.length, label: t('card.seg.d90') },
          { key: 'idle', n: total - stalled90.length, label: '—' },
        ],
        note: worstStalled
          ? t('card.stalled90.note', { name: worstStalled.project, n: worstStalled.days })
          : t('card.stalled90.note.none'),
        filters: { health: 'stalled90' },
      },
      {
        label: t('card.norecord'),
        value: norecord.length,
        tone: 'alert',
        aux: t('card.share', { n: pct(norecord.length, total) }),
        segments: [
          { key: 'never', n: norecord.length, label: t('card.seg.never') },
          { key: 'idle', n: total - norecord.length, label: '—' },
        ],
        note: norecordNoPic ? t('card.norecord.note', { n: norecordNoPic }) : t('card.norecord.note.all'),
        filters: { health: 'norecord' },
      },
      {
        label: t('card.impact'),
        value: highImpact.length,
        tone: impactAtRisk ? 'alert' : 'good',
        aux: t('card.share', { n: pct(highImpact.length, total) }),
        segments: [
          { key: 'risk', n: impactAtRisk, label: t('card.seg.risk') },
          { key: 'live', n: highImpact.filter((r) => r.status === 'Live').length, label: t('card.seg.live') },
          { key: 'ok', n: highImpact.filter((r) => !needsAttention(r) && r.status !== 'Live').length, label: t('card.seg.ok') },
          { key: 'idle', n: total - highImpact.length, label: '—' },
        ],
        note: impactAtRisk ? t('card.impact.note', { n: impactAtRisk }) : t('card.impact.note.none'),
        filters: { impact: 'High' },
      },
    ];

    $('kpis').innerHTML = CARDS.map((c, i) => {
      const sum = c.segments.reduce((a, s) => a + s.n, 0) || 1;
      const bar = c.segments
        .filter((s) => s.n > 0)
        .map((s) => `<span class="seg ${s.key}" style="width:${(s.n / sum) * 100}%" title="${escape(s.label)} ${s.n}"></span>`)
        .join('');
      return `
        <button type="button" class="kpi ${c.tone ?? ''}" data-kpi="${i}">
          <span class="kpi-label">${escape(c.label)}</span>
          <span class="kpi-row">
            <span class="kpi-value">${c.value}</span>
            ${c.aux ? `<span class="kpi-aux">${escape(c.aux)}</span>` : ''}
          </span>
          <span class="kpi-bar">${bar}</span>
          <span class="kpi-note">${escape(c.note)}</span>
        </button>`;
    }).join('');

    $('kpis').onclick = (event) => {
      const button = event.target.closest('[data-kpi]');
      if (button) drillTo(CARDS[Number(button.dataset.kpi)].filters);
    };
  }

  /* ================================================================ panels */
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

    $(elementId).innerHTML =
      sorted
        .map(
          ([value, v]) => `
      <button type="button" class="bd-row" data-value="${escape(value)}">
        <span class="bd-label">${escape(value || emptyLabel)}</span>
        <span class="bd-bar" title="${v.live} ${escape(t('legend.live'))} · ${v.attention} ${escape(t('legend.risk'))} · ${
          v.total - v.live - v.attention
        } ${escape(t('legend.rest'))}">
          <span class="seg live" style="width:${pct(v.live, max)}%"></span>
          <span class="seg risk" style="width:${pct(v.attention, max)}%"></span>
          <span class="seg rest" style="width:${pct(v.total - v.live - v.attention, max)}%"></span>
        </span>
        <span class="bd-count">${v.total}<em>${v.attention ? ` · ${v.attention}` : ''}</em></span>
      </button>`,
        )
        .join('') +
      `<p class="bd-foot"><span class="key live"></span> ${escape(t('legend.live'))} &nbsp; <span class="key risk"></span> ${escape(
        t('legend.risk'),
      )} &nbsp; <span class="key rest"></span> ${escape(t('legend.rest'))}</p>`;

    $(elementId).onclick = (event) => {
      const button = event.target.closest('[data-value]');
      if (button) drillTo(filterFor(button.dataset.value));
    };
  }

  function renderAging() {
    const open = ROWS.filter((r) => r.status !== 'Live');
    const BUCKETS = [
      { key: 'ok', label: t('aging.b1'), test: (r) => r.days !== null && r.days <= 14, health: '' },
      { key: 'watch', label: t('aging.b2'), test: (r) => r.days !== null && r.days > 14 && r.days <= 30, health: 'watch' },
      { key: 'd30', label: t('aging.b3'), test: (r) => r.days !== null && r.days > 30 && r.days <= 90, health: 'stalled30' },
      { key: 'd90', label: t('aging.b4'), test: (r) => r.days !== null && r.days > 90, health: 'stalled90' },
      { key: 'never', label: t('aging.b5'), test: (r) => r.days === null, health: 'norecord' },
    ];
    const max = Math.max(1, ...BUCKETS.map((b) => open.filter(b.test).length));

    $('by-aging').innerHTML =
      BUCKETS.map((b) => {
        const count = open.filter(b.test).length;
        return `
        <button type="button" class="bd-row" data-health="${b.health}" ${count === 0 ? 'disabled' : ''}>
          <span class="bd-label">${escape(b.label)}</span>
          <span class="bd-bar"><span class="seg ${b.key}" style="width:${pct(count, max)}%"></span></span>
          <span class="bd-count">${count}</span>
        </button>`;
      }).join('') +
      `<p class="bd-foot">${escape(t('aging.foot', { live: ROWS.length - open.length, open: open.length }))}</p>`;

    $('by-aging').onclick = (event) => {
      const button = event.target.closest('[data-health]');
      if (button && !button.disabled) drillTo({ health: button.dataset.health });
    };
  }

  function renderTop() {
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
            <span class="t-days ${daysClass(r)}">${escape(daysText(r))}</span>
          </button>
        </li>`,
          )
          .join('')
      : `<li class="bd-foot">${escape(t('top.none'))}</li>`;

    $('top-attention').onclick = (event) => {
      const button = event.target.closest('[data-project]');
      if (button) drillTo({ q: button.dataset.project });
    };
  }

  function renderDashboard() {
    renderCards();
    renderBreakdown('by-pic', 'pic', (value) => ({ pic: value }), t('label.nopic'));
    renderBreakdown('by-category', 'category', (value) => ({ category: value }), t('label.uncategorised'));
    renderAging();
    renderTop();
  }

  /* ================================================================ list */
  const uniqueSorted = (key) =>
    [...new Set(ROWS.map((r) => r[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  function buildSelects() {
    const fill = (id, first, values) => {
      const select = $(id);
      const current = select.value;
      select.innerHTML =
        `<option value="">${escape(first)}</option>` +
        values.map(([v, label]) => `<option value="${escape(v)}">${escape(label)}</option>`).join('');
      select.value = current;
    };

    fill('f-status', t('filter.status'), uniqueSorted('status').map((v) => [v, v]));
    fill('f-category', t('filter.category'), uniqueSorted('category').map((v) => [v, v]));
    fill('f-pic', t('filter.pic'), uniqueSorted('pic').map((v) => [v, v]));
    fill(
      'f-stage',
      t('filter.stage'),
      STEPS.filter((s) => ROWS.some((r) => r.progress === s.weight)).map((s) => [String(s.weight), `${s.label} (${s.weight}%)`]),
    );
    fill('f-health', t('filter.health'), [
      ['attention', t('health.attention')],
      ['norecord', t('health.norecord')],
      ['stalled90', t('health.stalled90')],
      ['stalled30', t('health.stalled30')],
      ['watch', t('health.watch')],
      ['live', t('health.live')],
    ]);
  }

  function visibleRows() {
    const q = state.q.trim().toLowerCase();

    const filtered = ROWS.filter((row) => {
      if (state.status && row.status !== state.status) return false;
      if (state.category && row.category !== state.category) return false;
      if (state.pic && row.pic !== state.pic) return false;
      if (state.impact && row.impact !== state.impact) return false;
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
          `<span class="step ${s.date ? 'hit' : ''} ${s.date && s.n === 11 ? 'final' : ''}" title="${escape(s.label)} · ${
            s.date ? fmtDate(s.date) : escape(t('detail.notreached'))
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
        <td class="num"><span class="days ${daysClass(row)}">${escape(daysText(row))}</span></td>
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
      row.currentStage ? t('detail.furthest', { stage: escape(row.currentStage) }) : t('detail.nostage'),
      row.delayNote ? t('detail.note', { note: escape(row.delayNote) }) : null,
      row.lastActivity ? t('detail.last', { date: fmtDate(row.lastActivity), n: row.days }) : t('detail.never'),
    ]
      .filter(Boolean)
      .join(' &nbsp;·&nbsp; ');

    return `
      <tr class="detail" data-detail="${row.no}">
        <td colspan="12">
          <div class="detail-inner">
            <div class="detail-title">${t('detail.title', { name: escape(row.project) })}</div>
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

    const scope =
      rows.length === ROWS.length
        ? t('list.count.all', { n: rows.length })
        : t('list.count.some', { n: rows.length, total: ROWS.length });
    const order =
      state.sort === 'attention' ? t('list.sort.attention') : t('list.sort.column', { key: state.sort, dir: state.dir });
    $('resultline').textContent = `${scope} · ${t('list.attention', { n: rows.filter(needsAttention).length })} · ${order}`;

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
    $('f-stage').value = state.stageAt;
    $('f-health').value = state.health;
    for (const id of ['f-status', 'f-category', 'f-pic', 'f-stage', 'f-health']) {
      $(id).dataset.empty = $(id).value === '' ? 'true' : 'false';
    }
  }

  /* ================================================================ language */
  function applyLanguage() {
    document.documentElement.lang = lang;
    localStorage.setItem('ict-lang', lang);

    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    $('foot-keys').innerHTML = t('foot.keys');
    $('search').placeholder = t('search.placeholder');
    $('search').setAttribute('aria-label', t('search.placeholder'));

    const generated = new Date(data.generatedAt);
    $('meta').textContent = t('meta.line', {
      n: ROWS.length,
      when: generated.toLocaleString(locale(), {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      file: data.sourceFile,
      sheet: data.sourceSheet,
    });

    for (const button of document.querySelectorAll('[data-lang]')) {
      button.setAttribute('aria-pressed', button.dataset.lang === lang ? 'true' : 'false');
    }

    buildSelects();
    syncControls();
    renderDashboard();
    renderList();
  }

  document.querySelector('.lang').addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (!button || button.dataset.lang === lang) return;
    lang = button.dataset.lang;
    applyLanguage();
  });

  /* ================================================================ events */
  $('search').addEventListener('input', (e) => {
    state.q = e.target.value;
    renderList();
  });

  for (const [id, key] of [
    ['f-status', 'status'],
    ['f-category', 'category'],
    ['f-pic', 'pic'],
    ['f-stage', 'stageAt'],
    ['f-health', 'health'],
  ]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.value;
      e.target.dataset.empty = e.target.value === '' ? 'true' : 'false';
      renderList();
    });
  }

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
    Object.assign(state, {
      q: '', status: '', category: '', pic: '', stageAt: '', health: '', impact: '', sort: 'attention', dir: 'asc',
    });
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
  applyLanguage();
  showTab(location.hash.slice(1) === 'list' ? 'list' : 'dashboard');
})();
