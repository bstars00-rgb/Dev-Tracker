/* OHMY Integration Tracker — read-only board. No framework, no build, no server. */
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
  // Weight 0 is not a stage — it means the sheet has no milestone date at all.
  const untracked = () => ({ n: 0, label: t('stage.untracked'), weight: 0 });

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
    'On Hold': 'hold',
    Dropped: 'dropped',
    Cancelled: 'dropped',
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
    // A milestone dated ahead of today is a plan someone typed early, not activity.
    // Counting days since it gave Hibeds "-19d", which reads as very fresh when the
    // truth is that nothing has happened yet.
    if (row.days < 0) return 'future';
    if (row.days > 90) return 'd90';
    if (row.days > 30) return 'd30';
    if (row.days > 14) return 'd14';
    return 'ok';
  };

  const daysText = (row) =>
    row.days === null ? t('value.never')
    : row.days < 0 ? t('value.future', { n: -row.days })
    : `${row.days}d`;

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
    country: '',
    stageAt: '',
    health: '',
    impact: '',
    route: '',
    klass: '',
    consistency: '',
    hideDone: false,
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
    Object.assign(state, { q: '', status: '', category: '', pic: '', stageAt: '', health: '', impact: '', route: '', load: '', klass: '' }, filters);
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
        const end = r.stages.find((s) => s.weight === 100 && s.date);
        if (dates.length < 2 || !end) return null;
        const span = Date.parse(`${end.date}T00:00:00Z`) - Math.min(...dates);
        return span > 0 ? Math.round(span / 86_400_000) : null;
      })
      .filter((v) => v !== null);
    return spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
  }

  /**
   * The band a project sits in, used as the first sort key everywhere the default
   * "attention" order applies. Work that is actually moving belongs at the top; a
   * prospect nobody has opened yet is a different conversation, and something already
   * shipped is not a task at all.
   */
  function band(row) {
    if (row.progress >= 100) return 2; // done
    if (row.progress > 0) return 0; // in progress
    return 1; // not started
  }

  /** Default ordering: band, then how stalled, then how far along, then how long. */
  const byAttention = (a, b) =>
    band(a) - band(b) || a.rank - b.rank || b.progress - a.progress || (b.days ?? 0) - (a.days ?? 0);

  const quietest = (rows) => rows.filter((r) => r.days !== null).sort((a, b) => b.days - a.days)[0] ?? null;

  /* ================================================================ what to do next */
  /**
   * Who actually writes the integration code.
   *  - a switching platform is named -> the connector is configured there
   *  - OHMY dev load is full or half -> we build it
   *  - otherwise                     -> the partner builds against our API
   * "OHMY Dev Load" in the sheet measures OUR effort, which is what makes this readable.
   */
  // route and watch are worked out in scripts/build.mjs and shipped on every row, so
  // the page and the Teams messages cannot disagree about who owns what.
  const routeOf = (row) => row.route;

  /**
   * Next step per stage, taken from the internal 9-phase API integration process.
   *
   * Credential work (DEV key at 40/45, live key at 70/75) and go-live monitoring are
   * always OHMY engineering whoever writes the client code — only the build itself
   * (50/60) follows the route. That is why a high-impact partner needing almost no OHMY
   * effort still lands on engineering at the key-issuing stages.
   */
  const STAGE_OWNER = {
    0: 'gsm', 20: 'gsm', 30: 'sla',
    40: 'dev', 45: 'dev',
    50: null, 60: null, // decided by the build route
    70: 'dev', 75: 'dev', 80: 'dev', 90: 'dev',
  };

  function nextAction(row) {
    if (row.progress >= 100) return null;

    const route = routeOf(row);
    const owner =
      STAGE_OWNER[row.progress] ?? (route === 'direct' ? 'dev' : route === 'switching' ? 'switching' : 'partner');

    return {
      owner,
      route,
      text: t(`act.p${row.progress}`),
      caveat: row.progress >= 50 && route !== 'direct' ? t(`act.route.${route}`, { sw: row.switching ?? '' }) : null,
      // The one hard gate in the process: no live key without both conditions.
      gate: row.progress === 60 || row.progress === 70 ? t('act.gate') : null,
    };
  }

  const routeLabel = (row) =>
    row.switching ? t('route.switching', { sw: row.switching }) : t(`route.${routeOf(row)}`);

  /**
   * Who holds this partner *at the stage it is on now*, as opposed to the one PIC who
   * carries it end to end. The sheet names a salesperson for the whole journey, but the
   * work hands over: GSM opens it, SLA papers it, engineering takes it from the DEV key
   * onward. Chasing the PIC on a row sitting at Live Test wastes a day.
   */
  function ownerNow(row) {
    if (row.parked) return row.parked;
    if (row.progress >= 100) return 'done';
    return nextAction(row).owner;
  }

  /**
   * Target date and how far off it is. Positive drift is late. Once a row is live the
   * drift is measured against the day it actually opened, so a shipped project keeps an
   * honest record instead of drifting further every time the page is loaded.
   */
  function targetState(row) {
    if (!row.target) return null;
    const late = (row.targetDrift ?? 0) > 0;
    const shipped = Boolean(row.liveDate);
    return {
      date: row.target,
      drift: row.targetDrift ?? 0,
      source: row.targetSource,
      tone: shipped ? (late ? 'shipped-late' : 'shipped-ontime') : late ? 'late' : 'ahead',
      text: shipped
        ? t(late ? 'target.shippedlate' : 'target.shippedok', { n: Math.abs(row.targetDrift ?? 0) })
        : t(late ? 'target.late' : 'target.left', { n: Math.abs(row.targetDrift ?? 0) }),
    };
  }

  function targetCell(row) {
    const ts = targetState(row);
    if (!ts) {
      return row.progress >= 100
        ? `<span class="faint">${escape(fmtDate(row.liveDate))}</span>`
        : `<span class="faint" title="${escape(t('target.none.why'))}">${escape(t('target.none'))}</span>`;
    }
    const why = ts.source === 'devdone' ? t('target.src.devdone') : t('target.src.target');
    return `<span class="target ${ts.tone}" title="${escape(fmtDate(ts.date))} · ${escape(why)}">${escape(ts.text)}</span>
            <span class="target-date">${escape(fmtDate(ts.date))}</span>`;
  }

  /**
   * How closely OHMY engineering needs to be watching this one, right now.
   *
   * Sales is monitoring every row by definition, so naming an "owner" told a developer
   * nothing. This says what the developer actually wants to know: is this on me, do I
   * have to review someone else's work, am I on call, or is it not mine yet.
   */
  const watchLevel = (row) => row.watch;

  const WATCH_ORDER = { omhbuild: 0, omhsupport: 1, switchreview: 2, partnerbuild: 3, heads: 4, sales: 5 };
  /** Levels where OHMY engineering itself has something to do. */
  const OMH_WORK = ['omhbuild', 'omhsupport', 'switchreview'];

  /**
   * Effort x impact, the classic action-priority split.
   *
   * Effort is OUR effort: the sheet's "OHMY Dev Load". Impact is revenue and volume
   * upside, not risk. Impact is only High or not — Mid and blank both land in "low", and
   * the panel says so out loud, because 93 of 108 rows have no impact set and pretending
   * otherwise would make the matrix lie.
   */
  const CLASSES = ['quickwin', 'major', 'fillin', 'justify'];

  function classOf(row) {
    const bigImpact = row.impact === 'High';
    // "OHMY writes it" is the effort axis now. The sheet dropped OHMY Dev Load because
    // Dev Owner says the same thing: work we build costs us, work a partner builds does
    // not. Coarser than Full/Half/Minimal was, and sourced from a column people fill.
    const bigEffort = ['direct', 'shared'].includes(row.route);
    if (!bigEffort) return bigImpact ? 'quickwin' : 'fillin';
    return bigImpact ? 'major' : 'justify';
  }

  const CLASS_ORDER = { quickwin: 0, major: 1, justify: 2, fillin: 3 };

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
    const mismatched = ROWS.filter((r) => r.consistent === false);

    const statusCounts = [...new Set(ROWS.map((r) => r.status))]
      .map((s) => ({ status: s, n: ROWS.filter((r) => r.status === s).length }))
      .sort((a, b) => b.n - a.n);

    const avgDays = averageDaysToLive();
    const furthest = inFlight.length ? inFlight.reduce((a, b) => (b.progress > a.progress ? b : a)) : null;
    const worstAttention = quietest(attention);
    const worstStalled = quietest(stalled90);
    const norecordNoPic = norecord.filter((r) => !r.pic).length;
    const impactAtRisk = highImpact.filter(needsAttention).length;

    const devQueue = ROWS.filter((r) => r.progress >= 40 && r.progress < 50);
    const devWip = ROWS.filter((r) => r.progress >= 50 && r.progress < 80);
    const switching = ROWS.filter((r) => r.switching);
    const omhBuilds = ROWS.filter((r) => ['direct', 'shared'].includes(r.route));

    const routeNote = (rows) =>
      t('card.route.note', {
        d: rows.filter((r) => ['direct', 'shared'].includes(routeOf(r))).length,
        p: rows.filter((r) => routeOf(r) === 'partner').length,
        s: rows.filter((r) => routeOf(r) === 'switching').length,
      });

    const routeSegments = (rows, rest) => [
      { key: 'rest', n: rows.filter((r) => ['direct', 'shared'].includes(routeOf(r))).length, label: t('route.direct') },
      { key: 'ok', n: rows.filter((r) => routeOf(r) === 'partner').length, label: t('route.partner') },
      { key: 'watch', n: rows.filter((r) => routeOf(r) === 'switching').length, label: t('owner.switching') },
      { key: 'idle', n: rest, label: '\u2014' },
    ];

    const impactNotStarted = highImpact.filter((r) => r.progress === 0).length;
    const impactInFlight = highImpact.filter((r) => r.progress > 0 && r.progress < 100).length;
    const impactLive = highImpact.filter((r) => r.progress >= 100).length;

    const switchList = [...new Set(switching.map((r) => r.switching))]
      .map((sw) => `${sw} ${switching.filter((r) => r.switching === sw).length}`)
      .join(' \u00b7 ');

    // Nine cards: three that frame the portfolio, four that answer "is this ours to build
    // and when", two that flag neglect. Every one is a link into the filtered list.
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
        label: t('card.impact'),
        value: highImpact.length,
        tone: 'impact',
        aux: t('card.share', { n: pct(highImpact.length, total) }),
        hint: t('card.impact.hint'),
        segments: [
          { key: 'idle2', n: impactNotStarted, label: t('card.seg.contact') },
          { key: 'rest', n: impactInFlight, label: t('card.seg.inflight') },
          { key: 'live', n: impactLive, label: t('card.seg.live') },
        ],
        note: highImpact.length
          ? t('card.impact.note2', { a: impactNotStarted, b: impactInFlight, c: impactLive })
          : t('card.impact.empty'),
        filters: { impact: 'High' },
      },
      {
        label: t('card.live'),
        value: live.length,
        tone: 'good',
        aux: t('card.share', { n: pct(live.length, total) }),
        segments: [
          { key: 'live', n: live.length, label: t('card.seg.live') },
          { key: 'idle', n: total - live.length, label: '\u2014' },
        ],
        note: (() => {
          const fake = live.filter((r) => r.progress < 100).length;
          if (fake) return t('card.live.note.mismatch', { n: fake });
          return avgDays === null ? t('card.live.note.none') : t('card.live.note', { n: avgDays });
        })(),
        filters: { status: 'Live' },
      },
      {
        label: t('card.devqueue'),
        value: devQueue.length,
        tone: 'info',
        segments: routeSegments(devQueue, total - devQueue.length),
        note: devQueue.length ? routeNote(devQueue) : t('card.devqueue.note.none'),
        filters: { stageAt: '40' },
      },
      {
        label: t('card.devwip'),
        value: devWip.length,
        tone: 'info',
        segments: routeSegments(devWip, total - devWip.length),
        note: devWip.length ? routeNote(devWip) : t('card.devwip.note.none'),
        filters: { stageAt: '50' },
      },
      {
        label: t('card.switching'),
        value: switching.length,
        tone: 'info',
        aux: t('card.share', { n: pct(switching.length, total) }),
        segments: [
          { key: 'watch', n: switching.length, label: t('owner.switching') },
          { key: 'idle', n: total - switching.length, label: '\u2014' },
        ],
        note: switching.length ? t('card.switching.note', { list: switchList }) : t('card.switching.note.none'),
        filters: { route: 'switching' },
      },
      {
        label: t('card.devfull'),
        value: omhBuilds.length,
        tone: 'info',
        aux: t('card.share', { n: pct(omhBuilds.length, total) }),
        segments: [
          { key: 'rest', n: omhBuilds.filter((r) => r.progress > 0 && r.progress < 100).length, label: t('card.seg.inflight') },
          { key: 'live', n: omhBuilds.filter((r) => r.progress >= 100).length, label: t('card.seg.live') },
          { key: 'idle2', n: omhBuilds.filter((r) => r.progress === 0).length, label: t('card.seg.contact') },
          { key: 'idle', n: total - omhBuilds.length, label: '\u2014' },
        ],
        note: t('card.devfull.note', { n: omhBuilds.filter((r) => r.progress > 0 && r.progress < 100).length }),
        filters: { omh: '1' },
      },
      {
        label: t('card.mismatch'),
        value: mismatched.length,
        tone: mismatched.length ? 'alert' : 'good',
        aux: t('card.share', { n: pct(mismatched.length, total) }),
        segments: [
          { key: 'risk', n: mismatched.length, label: t('consistency.bad') },
          { key: 'idle', n: total - mismatched.length, label: '—' },
        ],
        note: !(data.counts?.hasConsistency ?? true)
          ? t('card.mismatch.na')
          : mismatched.length
          ? t('card.mismatch.note', {
              top: Object.entries(
                mismatched.reduce((a, r) => ((a[r.consistency ?? '—'] = (a[r.consistency ?? '—'] ?? 0) + 1), a), {}),
              ).sort((a, b) => b[1] - a[1])[0][0],
            })
          : t('card.mismatch.none'),
        filters: { consistency: 'bad' },
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
          { key: 'idle', n: total - stalled90.length, label: '\u2014' },
        ],
        note: worstStalled
          ? t('card.stalled90.note', { name: worstStalled.project, n: worstStalled.days })
          : t('card.stalled90.note.none'),
        filters: { health: 'stalled90' },
      },
    ];

    $('kpis').innerHTML = CARDS.map((c, i) => {
      const sum = c.segments.reduce((a, s) => a + s.n, 0) || 1;
      const bar = c.segments
        .filter((s) => s.n > 0)
        .map((s) => `<span class="seg ${s.key}" style="width:${(s.n / sum) * 100}%" title="${escape(s.label)} ${s.n}"></span>`)
        .join('');
      return `
        <button type="button" class="kpi ${c.tone ?? ''}" data-kpi="${i}"${c.hint ? ` title="${escape(c.hint)}"` : ''}>
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
      .sort(byAttention)
      .slice(0, 10);

    $('top-attention').innerHTML = top.length
      ? top
          .map(
            (r) => `
        <li>
          <button type="button" class="top-row" data-project="${escape(r.project)}">
            <span class="t-name">${escape(r.project)}${r.impact === 'High' ? '<span class="flag">HIGH</span>' : ''}</span>
            <span class="t-stage">${escape(r.currentStage ?? t('stage.untracked'))}</span>
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

  let actionsScope = 'all';

  /** The table that answers "what does engineering do about this one, today". */
  function renderActions() {
    const candidates = ROWS.filter(
      (r) => (r.progress > 0 && r.progress < 100) || (r.impact === 'High' && r.progress === 0),
    );

    const rows = candidates
      .map((row) => ({ row, action: nextAction(row) }))
      .filter(({ action }) => action !== null)
      .filter(({ row }) => actionsScope === 'all' || OMH_WORK.includes(watchLevel(row)))
      .sort((a, b) => {
        const impact = (r) => (r.impact === 'High' ? 0 : r.impact === 'Mid' ? 1 : 2);
        // Engineering first, and inside that the biggest commercial upside first.
        return (
          WATCH_ORDER[watchLevel(a.row)] - WATCH_ORDER[watchLevel(b.row)] ||
          CLASS_ORDER[classOf(a.row)] - CLASS_ORDER[classOf(b.row)] ||
          impact(a.row) - impact(b.row) ||
          b.row.progress - a.row.progress ||
          (b.row.days ?? 0) - (a.row.days ?? 0)
        );
      });

    $('actions-scope').innerHTML = [
      ['all', t('panel.actions.all')],
      ['dev', t('panel.actions.dev')],
    ]
      .map(
        ([key, label]) =>
          `<button type="button" data-scope="${key}" aria-pressed="${actionsScope === key}">${escape(label)}</button>`,
      )
      .join('');

    const tally = (level) => candidates.filter((r) => watchLevel(r) === level).length;
    $('actions-summary').textContent = t('watch.summary', {
      build: tally('omhbuild'),
      support: tally('omhsupport'),
      review: tally('switchreview'),
      partner: tally('partnerbuild'),
      heads: tally('heads'),
    });

    $('actions-body').innerHTML = rows.length
      ? rows
          .map(
            ({ row, action }) => `
        <tr data-project="${escape(row.project)}">
          <td class="a-name">${escape(row.project)}</td>
          <td class="dim">${row.impact ? escape(row.impact) : '\u2014'}</td>
          <td>
            <span class="route ${routeOf(row)}">${escape(routeLabel(row))}</span>
            ${routeOf(row) === 'shared' ? `<span class="a-load">${escape(row.devOwner)}</span>` : ''}
          </td>
          <td><span class="klass ${classOf(row)}">${escape(t(`class.${classOf(row)}`))}</span></td>
          <td class="dim">${escape(row.currentStage ?? t('stage.untracked'))} <span class="a-pct">${row.progress}%</span></td>
          <td class="a-next">
            ${escape(action.text)}
            ${action.caveat ? `<span class="a-caveat">${escape(action.caveat)}</span>` : ''}
            ${action.gate ? `<span class="a-gate">${escape(action.gate)}</span>` : ''}
          </td>
          <td class="a-watch">
            <span class="watch ${watchLevel(row)}" title="${escape(t(`watch.${watchLevel(row)}.why`))}">${escape(
              t(`watch.${watchLevel(row)}`),
            )}</span>
            ${['heads', 'sales'].includes(watchLevel(row))
              ? `<span class="a-lead">${escape(t('watch.lead', { who: t(`owner.${action.owner}`) }))}</span>`
              : ''}
          </td>
          <td class="num"><span class="days ${daysClass(row)}">${escape(daysText(row))}</span></td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="8" class="empty">${escape(t('panel.actions.empty'))}</td></tr>`;

    $('actions-scope').onclick = (event) => {
      const button = event.target.closest('[data-scope]');
      if (!button) return;
      actionsScope = button.dataset.scope;
      renderActions();
    };

    $('actions-body').onclick = (event) => {
      const tr = event.target.closest('tr[data-project]');
      if (tr) drillTo({ q: tr.dataset.project });
    };
  }

  /** The 2x2. Counts are whole-portfolio, not just the in-flight rows. */
  function renderMatrix() {
    const cell = (klass) => ROWS.filter((r) => classOf(r) === klass);
    const boxes = [
      { klass: 'quickwin', row: 0, col: 0 },
      { klass: 'fillin', row: 0, col: 1 },
      { klass: 'major', row: 1, col: 0 },
      { klass: 'justify', row: 1, col: 1 },
    ];

    $('matrix').innerHTML =
      `<div class="mx-corner"></div>
       <div class="mx-head">${escape(t('matrix.impact.high'))}</div>
       <div class="mx-head">${escape(t('matrix.impact.low'))}</div>
       <div class="mx-side">${escape(t('matrix.effort.low'))}</div>` +
      boxes
        .slice(0, 2)
        .map((b) => boxHtml(b.klass, cell(b.klass)))
        .join('') +
      `<div class="mx-side">${escape(t('matrix.effort.high'))}</div>` +
      boxes
        .slice(2)
        .map((b) => boxHtml(b.klass, cell(b.klass)))
        .join('');

    function boxHtml(klass, rows) {
      const live = rows.filter((r) => r.progress >= 100).length;
      const risk = rows.filter(needsAttention).length;
      return `
        <button type="button" class="mx-box ${klass}" data-class="${klass}">
          <span class="mx-name">${escape(t(`class.${klass}`))}</span>
          <span class="mx-value">${rows.length}</span>
          <span class="mx-bar">
            <span class="seg live" style="width:${pct(live, rows.length || 1)}%"></span>
            <span class="seg risk" style="width:${pct(risk, rows.length || 1)}%"></span>
            <span class="seg rest" style="width:${pct(rows.length - live - risk, rows.length || 1)}%"></span>
          </span>
          <span class="mx-desc">${escape(t(`class.${klass}.desc`))}</span>
        </button>`;
    }

    $('matrix-note').textContent = t('matrix.unknown', { n: ROWS.filter((r) => !r.impact).length });

    $('matrix').onclick = (event) => {
      const button = event.target.closest('[data-class]');
      if (button) drillTo({ klass: button.dataset.class });
    };
  }

  function renderDashboard() {
    renderCards();
    renderMatrix();
    renderActions();
    renderBreakdown('by-pic', 'pic', (value) => ({ pic: value }), t('label.nopic'));
    renderBreakdown('by-category', 'category', (value) => ({ category: value }), t('label.uncategorised'));
    renderAging();
    renderTop();
    renderCoverage();
    renderGaps();
  }

  /**
   * How much of the eleven-stage funnel each partner type actually records.
   *
   * The team asked whether progress percentages are comparable across Channel API,
   * Switching, CRS and 3rd Party. On this sheet they are not, and the reason is blunter
   * than differing definitions: only Channel API rows carry stage dates at all. A CRS
   * row reading 0% is not behind, it is untracked. This panel shows which is which
   * rather than letting the funnel imply a comparison it cannot support.
   */
  function renderCoverage() {
    const cov = data.counts?.stageCoverage;
    const host = $('by-coverage');
    if (!host) return;
    if (!cov) { host.innerHTML = ''; return; }

    host.innerHTML = Object.entries(cov)
      .sort((a, b) => b[1].rows - a[1].rows)
      .map(([name, c]) => {
        const share = c.rows ? Math.round((c.dated / c.rows) * 100) : 0;
        return `
        <div class="cov-row ${c.dated === 0 ? 'blank' : ''}">
          <span class="cov-name">${escape(name)}</span>
          <span class="cov-meter ${c.dated === 0 ? 'empty' : ''}"><span style="width:${c.dated === 0 ? 100 : share}%"></span></span>
          <span class="cov-note">${escape(
            c.dated === 0 ? t('cov.none') : t('cov.row', { dated: c.dated, rows: c.rows, used: c.stagesUsed, total: c.stagesTotal }),
          )}</span>
        </div>`;
      })
      .join('');
  }

  /**
   * Columns the board knows how to render but this workbook does not carry. Said out
   * loud, next to the data, so a blank column reads as "nobody records this" instead of
   * "nothing is wrong".
   */
  function renderGaps() {
    const host = $('data-gaps');
    if (!host) return;
    const c = data.counts ?? {};
    const fallbacks = ROWS.filter((r) => r.targetSource === 'devdone').length;
    const total = ROWS.length;

    // A column that exists but is empty is not the same as a missing one, and it is the
    // easier state to miss: the board stops complaining while still knowing nothing.
    // Say which of the two it is.
    const gap = (has, filled, missingKey, emptyKey, vars = {}) => {
      if (!has) return t(missingKey, { ...vars, total });
      return filled === 0 ? t(emptyKey, { total }) : null;
    };

    const notes = [
      gap(c.hasTarget, c.withTarget, 'gap.target', 'gap.target.empty', { n: fallbacks }),
      gap(c.hasBlocker, c.withBlocker, 'gap.blocker', 'gap.blocker.empty'),
      gap(c.hasParkedFlag, c.parked, 'gap.parked', 'gap.parked.empty'),
      c.hasDevOwner && c.withDevOwner === 0 ? t('gap.devowner.empty', { total }) : null,
      !c.hasDevOwner ? t('gap.devowner') : null,
    ].filter(Boolean);

    host.hidden = notes.length === 0;
    host.innerHTML = notes.map((n) => `<li>${n}</li>`).join('');
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
    fill('f-pic', t('filter.pic'), uniqueSorted('pic').map((v) => [v, v]));
    fill('f-country', t('filter.country'), uniqueSorted('country').map((v) => [v, v]));
    fill(
      'f-stage',
      t('filter.stage'),
      [untracked(), ...STAGE_MODEL]
        .filter((s) => ROWS.some((r) => r.progress === s.weight))
        .map((s) => [String(s.weight), s.weight === 0 ? s.label : `${s.label} (${s.weight}%)`]),
    );
    fill('f-class', t('filter.class'), CLASSES.map((c) => [c, t(`class.${c}`)]));
    fill('f-consistency', t('filter.consistency'), [['bad', t('consistency.bad')], ['ok', t('consistency.ok')]]);
    fill('f-health', t('filter.health'), [
      ['attention', t('health.attention')],
      ['norecord', t('health.norecord')],
      ['stalled90', t('health.stalled90')],
      ['stalled30', t('health.stalled30')],
      ['watch', t('health.watch')],
      ['live', t('health.live')],
    ]);
  }

  /** The filter predicate, pulled out so the category tabs can count with it too. */
  function applyFilters(rows, s) {
    const q = s.q.trim().toLowerCase();
    return rows.filter((row) => {
      if (s.status && row.status !== s.status) return false;
      if (s.category && row.category !== s.category) return false;
      if (s.pic && row.pic !== s.pic) return false;
      if (s.country && row.country !== s.country) return false;
      if (s.impact && row.impact !== s.impact) return false;
      if (s.route && routeOf(row) !== s.route) return false;
      if (s.omh && !['direct', 'shared'].includes(row.route)) return false;
      if (s.klass && classOf(row) !== s.klass) return false;
      if (s.consistency === 'bad' && row.consistent !== false) return false;
      if (s.consistency === 'ok' && row.consistent === false) return false;
      if (s.hideDone && row.progress >= 100) return false;
      if (s.stageAt !== '' && row.progress !== Number(s.stageAt)) return false;
      if (s.health) {
        if (s.health === 'attention') {
          if (!needsAttention(row)) return false;
        } else if (row.health !== s.health) return false;
      }
      if (q) {
        const hay = [row.project, row.category, row.status, row.pic, row.team, row.switching, row.currentStage]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function visibleRows() {
    const filtered = applyFilters(ROWS, state);

    const key = state.sort;
    const sign = state.dir === 'asc' ? 1 : -1;

    // Default order: what needs a human first. Severity band, then how far along the
    // integration is (more invested = more at stake), then how long it has been quiet.
    if (key === 'attention') return filtered.sort(byAttention);

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

  /**
   * Stage owner, plus the sheet's assigned team when the two differ. A row where the
   * process says SLA and the sheet says GSM is worth seeing; one where both say GSM is
   * just the same word twice.
   */
  function ownerCell(row) {
    const who = ownerNow(row);
    const label = t(`owner.${who}`);
    const team = row.team && row.team.toUpperCase() !== label.toUpperCase() ? row.team : null;
    return `<span class="own ${who}" title="${escape(t('owner.why'))}">${escape(label)}</span>${
      team ? `<span class="own-team" title="${escape(t('owner.assigned'))}">${escape(team)}</span>` : ''
    }`;
  }

  /** The derived next step, kept short enough for a table cell; full text in the title. */
  function nextCell(row) {
    if (row.parked) return `<span class="faint">${escape(t(`parked.${row.parked}`))}</span>`;
    const action = nextAction(row);
    if (!action) return `<span class="faint">${escape(t('act.done'))}</span>`;
    const full = [action.text, action.caveat, action.gate].filter(Boolean).join(' · ');
    return `<span class="nextstep" title="${escape(full)}">${escape(action.text)}</span>`;
  }

  function rowHtml(row) {
    const statusClass = STATUS_CLASS[row.status] ?? 'contact';
    const track = row.stages
      .map(
        (s) =>
          `<span class="step ${s.date ? 'hit' : ''} ${s.date && s.weight === 100 ? 'final' : ''}" title="${escape(s.label)} · ${
            s.date ? fmtDate(s.date) : escape(t('detail.notreached'))
          }">${s.n}</span>`,
      )
      .join('');

    return `
      <tr class="row ${state.open.has(row.no) ? 'open' : ''}" data-no="${row.no}">
        <td class="num">${escape(row.no)}</td>
        <td class="partner">${escape(row.project)}${row.impact === 'High' ? '<span class="flag">HIGH</span>' : ''}${
          row.blocker ? `<span class="blocked" title="${escape(row.blocker)}">${escape(t('label.blocked'))}</span>` : ''
        }</td>
        <td class="dim">${escape(row.category)}</td>
        <td><span class="chip ${statusClass}">${escape(row.status)}</span></td>
        <td>
          <span class="progress">
            <span class="bar ${row.progress === 100 ? 'done' : ''}"><span style="width:${row.progress}%"></span></span>
            <span class="pct">${row.progress}%</span>
          </span>
        </td>
        <td class="track-cell"><span class="track">${track}</span></td>
        <td class="c-next">${nextCell(row)}</td>
        <td class="c-owner">${ownerCell(row)}</td>
        <td>${row.pic ? escape(row.pic) : '<span class="faint">—</span>'}</td>
        <td>${
          row.devOwner
            ? `<span class="own ${routeOf(row)}">${escape(row.devOwner)}</span>`
            : '<span class="faint">—</span>'
        }</td>
        <td class="c-switching dim">${row.switching ? escape(row.switching) : '—'}</td>
        <td class="c-target">${targetCell(row)}</td>
        <td class="dim">${fmtDate(row.lastActivity)}</td>
        <td class="num"><span class="days ${daysClass(row)}">${escape(daysText(row))}</span></td>
      </tr>`;
  }

  const daysApart = (fromISO, toISO) =>
    Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);

  function detailHtml(row) {
    // Three states, not two. A stage with no date that sits *before* one that has a date
    // was never logged - which is a different fact from a stage the project has simply
    // not reached yet. Klook records ④ through ⑧ but nothing for NDA, Contract or SLA.
    const lastHit = row.stages.reduce((acc, s, i) => (s.date ? i : acc), -1);
    let previousDate = null;

    const stages = row.stages
      .map((s, i) => {
        const state = s.date ? 'hit' : i < lastHit ? 'skipped' : 'ahead';
        const gap = s.date && previousDate ? daysApart(previousDate, s.date) : null;
        if (s.date) previousDate = s.date;

        const value =
          state === 'hit' ? fmtDate(s.date) : state === 'skipped' ? t('stage.skipped') : t('stage.ahead');

        // A negative gap means this milestone is dated before the one above it. Linkstay
        // is marked API Live Complete in January against a Live Test in May. Saying
        // "+-120d" hid that; calling it backwards puts it in front of whoever opened the row.
        const back = gap !== null && gap < 0;
        const isNow = i === lastHit && row.progress < 100;

        return `
        <li class="stagerow ${state} ${s.date && s.weight === 100 ? 'final' : ''} ${isNow ? 'now' : ''}">
          <span class="sdot"></span>
          <span class="n">${String(s.n).padStart(2, '0')}</span>
          <span class="l">${escape(s.label)}</span>
          <span class="d">${escape(value)}</span>
          <span class="g ${back ? 'back' : ''}" ${back ? `title="${escape(t('stage.gapback.why'))}"` : ''}>${
            gap === null ? '' : escape(t(back ? 'stage.gapback' : 'stage.gap', { n: Math.abs(gap) }))
          }</span>
          ${isNow ? `<span class="nowtag">${escape(t('stage.now'))}</span>` : ''}
        </li>`;
      })
      .join('');

    const ts = targetState(row);
    const action = nextAction(row);

    // Label above value, one fact per cell. The single run-on line these used to share
    // made the blocker read like part of the date next to it.
    const facts = [
      [t('fact.stage'), row.currentStage ? escape(row.currentStage) : t('detail.nostage'), false],
      [t('th.owner'), escape(t(`owner.${ownerNow(row)}`)), false],
      [t('th.target'), ts ? `${escape(fmtDate(ts.date))} <em>${escape(ts.text)}</em>` : t('target.none'), false],
      [
        t('th.last'),
        row.lastActivity ? `${escape(fmtDate(row.lastActivity))} <em>${escape(t('detail.ago', { n: row.days }))}</em>` : t('detail.never'),
        false,
      ],
      action ? [t('th.next'), [action.text, action.caveat, action.gate].filter(Boolean).map(escape).join(' · '), true] : null,
      row.blocker ? [t('fact.blocker'), escape(row.blocker), true] : null,
      row.delayNote ? [t('fact.delay'), escape(row.delayNote), false] : null,
      row.consistent === false ? [t('fact.consistency'), escape(row.consistency ?? ''), false] : null,
      row.note ? [t('fact.note'), escape(row.note), true] : null,
    ]
      .filter(Boolean)
      .map(([label, value, wide]) => `
        <div class="fact ${wide ? 'wide' : ''}">
          <dt>${escape(label)}</dt>
          <dd>${value}</dd>
        </div>`)
      .join('');

    return `
      <tr class="detail" data-detail="${row.no}">
        <td colspan="14">
          <div class="detail-inner">
            <div class="detail-title">${t('detail.title', { name: escape(row.project) })}</div>
            <div class="detail-cols">
              <ol class="stagelist">${stages}</ol>
              <dl class="factlist">${facts}</dl>
            </div>
          </div>
        </td>
      </tr>`;
  }

  /**
   * Category sub-tabs across the top of the list. Counts respect every other active
   * filter but not the category itself, so switching tabs while a PIC filter is on
   * shows how that person's work splits across categories instead of resetting to the
   * whole portfolio.
   */
  const CATEGORY_TOTALS = ROWS.reduce((acc, r) => ((acc[r.category] = (acc[r.category] ?? 0) + 1), acc), {});
  const totalPerCategory = (name) => CATEGORY_TOTALS[name] ?? 0;

  function renderCategoryTabs() {
    const withoutCategory = { ...state, category: '' };
    const pool = applyFilters(ROWS, withoutCategory);

    const counts = new Map();
    for (const row of pool) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);

    // Every category the sheet contains stays visible even when a filter empties it, so
    // a tab never disappears mid-session. Order is fixed by the total size of each
    // category, not the filtered count, so the strip does not reshuffle under the cursor.
    const categories = [...new Set(ROWS.map((r) => r.category))].sort(
      (a, b) => totalPerCategory(b) - totalPerCategory(a) || a.localeCompare(b),
    );

    const tab = (value, label, n) => `
      <button type="button" role="tab" data-cat="${escape(value)}" aria-selected="${state.category === value}"
              ${n === 0 && value !== '' && state.category !== value ? 'disabled' : ''}>
        ${escape(label)}<span class="sub-count">${n}</span>
      </button>`;

    $('cat-tabs').innerHTML =
      tab('', t('cat.all'), pool.length) + categories.map((c) => tab(c, c, counts.get(c) ?? 0)).join('');
  }

  $('cat-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-cat]');
    if (!button || button.disabled) return;
    state.category = button.dataset.cat;
    renderList();
  });

  function renderList() {
    const rows = visibleRows();

    $('tbody').innerHTML = rows.map((row) => rowHtml(row) + (state.open.has(row.no) ? detailHtml(row) : '')).join('');
    renderCategoryTabs();
    renderDoneToggle();
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

  function renderDoneToggle() {
    const done = ROWS.filter((r) => r.progress >= 100).length;
    const button = $('toggle-done');
    button.textContent = t(state.hideDone ? 'btn.showdone' : 'btn.hidedone', { n: done });
    button.setAttribute('aria-pressed', String(state.hideDone));
    button.hidden = done === 0;
  }

  $('toggle-done').addEventListener('click', () => {
    state.hideDone = !state.hideDone;
    renderList();
  });

  function syncControls() {
    $('search').value = state.q;
    $('f-status').value = state.status;
    $('f-pic').value = state.pic;
    $('f-country').value = state.country;
    $('f-stage').value = state.stageAt;
    $('f-class').value = state.klass;
    $('f-consistency').value = state.consistency;
    $('f-health').value = state.health;
    for (const id of ['f-status', 'f-pic', 'f-country', 'f-stage', 'f-class', 'f-consistency', 'f-health']) {
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
    ['f-pic', 'pic'],
    ['f-country', 'country'],
    ['f-stage', 'stageAt'],
    ['f-class', 'klass'],
    ['f-consistency', 'consistency'],
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
      q: '', status: '', category: '', pic: '', country: '', stageAt: '', health: '', impact: '', route: '', omh: '', klass: '', consistency: '', hideDone: false,
      sort: 'attention', dir: 'asc',
    });
    state.open.clear();
    syncControls();
    renderList();
  });

  $('export').addEventListener('click', () => {
    const header = [
      'No', 'Project', 'Category', 'Country', 'Status', 'Progress %', 'Current stage', 'Biz impact',
      'PIC', 'Team', 'Dev owner', 'Build route', 'Class', 'Switching', 'Target go-live', 'Blocker',
      'Last activity', 'Days since', 'Health', 'Consistency',
    ];
    const cell = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = visibleRows().map((r) =>
      [r.no, r.project, r.category, r.country ?? '', r.status, r.progress, r.currentStage ?? '', r.impact ?? '',
       r.pic ?? '', r.team ?? '', r.devOwner ?? '', routeOf(r), t(`class.${classOf(r)}`), r.switching ?? '',
       r.target ?? '', r.blocker ?? '', r.lastActivity ?? '',
       r.days ?? '', r.health, r.consistency ?? ''].map(cell).join(','),
    );
    // BOM so Excel opens the UTF-8 partner names correctly.
    const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `integration-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
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
