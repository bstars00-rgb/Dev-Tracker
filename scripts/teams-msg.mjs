/**
 * Teams messages from the tracker.
 *
 *   node scripts/teams-msg.mjs [YYYY-MM-DD]
 *   -> output/teams-tracker-dev-<date>.html      IT x GSM + Contents  (English)
 *   -> output/teams-tracker-sales-<date>.html    Global Sales Team    (Korean)
 *   -> output/teams-tracker-leaders-<date>.html  Global SCM Director  (Korean)
 *
 * Three audiences, three different questions:
 *   developers - what do I owe this week
 *   sales      - which of my partners has stopped moving
 *   leaders    - how big is the problem and what needs deciding
 *
 * Only in-flight integrations appear. Live ones are finished and the not-started ones
 * are a pipeline question, not a weekly one - including either buried the ten or so
 * rows that actually moved.
 *
 * Posting is a separate step, so this can be read before anything is sent:
 *   node scripts/post-teams.js msg "<chat>" <html>          (dry run)
 *   node scripts/post-teams.js msg "<chat>" <html> --send   (send)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'output');
const BOARD_URL = 'https://bstars00-rgb.github.io/Integration-Tracker/';

/** Days without a milestone before a partner counts as stalled. */
const STALE_DAYS = 45;

const FONT = "font-family:'Segoe UI',system-ui,-apple-system,sans-serif";
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CH = { dev: 'IT x GSM + Contents', sales: 'Global Sales Team', leaders: 'Global SCM Director' };

/* ------------------------------------------------------------------ data */
const dataPath = path.join(root, 'data', 'tracker.json');
if (!fs.existsSync(dataPath)) {
  console.error('\nNo data/tracker.json. Run "npm run build" first.\n');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
const shortDate = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
};

// route and watch are computed in build.mjs and shipped on the row, so these messages
// and the board cannot disagree about who owns what.
const inFlight = data.rows.filter((r) => r.progress > 0 && r.progress < 100);
const stalled = inFlight
  .filter((r) => r.days !== null && r.days >= STALE_DAYS)
  .sort((a, b) => b.days - a.days);
const moving = inFlight.filter((r) => r.days === null || r.days < STALE_DAYS);

const OMH_WORK = ['omhbuild', 'omhsupport', 'switchreview'];
const devWork = inFlight
  .filter((r) => OMH_WORK.includes(r.watch))
  .sort((a, b) => {
    const rank = { omhbuild: 0, switchreview: 1, omhsupport: 2 };
    return rank[a.watch] - rank[b.watch] || b.progress - a.progress;
  });
const partnerWait = inFlight.filter((r) => r.watch === 'partnerbuild');

const stageOf = (row) => {
  const hit = row.stages.filter((s) => s.date).pop();
  return hit ? hit.label : '-';
};

const byPic = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const key = r.pic || '-';
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || b[1][0].days - a[1][0].days);
};

/* ------------------------------------------------------------------ shared bits */
const wrap = (body) => `<div style="${FONT};font-size:14px;color:#242424">${body}</div>`;
const title = (text) =>
  `<div style="${FONT};font-size:15px;font-weight:700;margin:0 0 2px 0">${text}</div>` +
  `<div style="${FONT};font-size:12px;margin:0 0 12px 0"><a href="${BOARD_URL}">${BOARD_URL}</a></div>`;
const line = `style="${FONT};font-size:14px;line-height:1.55;margin:2px 0"`;
const rule = (text) =>
  `<div style="${FONT};font-size:13px;font-weight:700;color:#5b4bd6;margin:14px 0 4px 0">${text}</div>`;
const foot = (text) => `<div style="${FONT};color:#888;font-size:12px;margin:14px 0 0 0">${text}</div>`;
const red = (t) => `<span style="color:#c0392b;font-weight:700">${t}</span>`;
const dim = (t) => `<span style="color:#666">${t}</span>`;

/* ------------------------------------------------------------------ 1. developers */
// Only the rows where OMH engineering owes a deliverable. Everything else is noise to
// someone deciding what to pick up on Monday.
function devMessage() {
  const WHAT = {
    omhbuild: 'OMH writes the code',
    omhsupport: 'partner builds, OMH owes a deliverable',
    switchreview: 'switching platform builds, OMH reviews',
  };
  const MARK = { omhbuild: '&#128308;', omhsupport: '&#128992;', switchreview: '&#128993;' };

  let b = title(`&#128225; Integration Tracker &mdash; ${shortDate(stamp)}`);

  if (!devWork.length) {
    b += `<div ${line}>Nothing is waiting on OMH engineering this week.</div>`;
  } else {
    b += `<div ${line}>OMH engineering owes something on <b>${devWork.length}</b> integration${
      devWork.length === 1 ? '' : 's'
    }:</div>`;
    b += '<div style="margin:8px 0 0 0">';
    for (const r of devWork) {
      const age = r.days === null ? 'no record' : `${r.days}d`;
      const flag = r.days !== null && r.days >= STALE_DAYS ? ` ${red('&#9888;')}` : '';
      b += `<div ${line}>${MARK[r.watch]} <b>${esc(r.project)}</b> &nbsp;${r.progress}% &nbsp;${dim(
        esc(stageOf(r)),
      )} &nbsp;&middot;&nbsp; ${esc(WHAT[r.watch])} &nbsp;${dim(age)}${flag}</div>`;
    }
    b += '</div>';
  }

  if (partnerWait.length) {
    const fresh = partnerWait.filter((r) => r.days !== null && r.days < 30).length;
    b += rule('Waiting on partners');
    b += `<div ${line}>${partnerWait.length} at 50%, certification scenarios already out. ` +
      `${fresh} moved in the last month. Nothing for us until they come back.</div>`;
  }

  const worst = devWork.find((r) => r.days !== null && r.days >= STALE_DAYS);
  if (worst) {
    b += rule('Worth a look');
    b += `<div ${line}><b>${esc(worst.project)}</b> is the most advanced integration still open ` +
      `at ${worst.progress}%, and has not moved in ${worst.days} days.</div>`;
  }

  b += foot(`In-flight only (${inFlight.length}). Live and not-started are excluded. Stalled = no milestone for ${STALE_DAYS}+ days.`);
  return wrap(b);
}

/* ------------------------------------------------------------------ 2. sales team */
// An alert, so it is grouped by the person who can act on it rather than by stage.
function salesMessage() {
  let b = title(`&#128680; Integration Tracker &mdash; 정체 알럿 (${shortDate(stamp)})`);

  if (!stalled.length) {
    b += `<div ${line}>진행중 ${inFlight.length}건 모두 최근 ${STALE_DAYS}일 안에 움직였습니다.</div>`;
    return wrap(b);
  }

  b += `<div ${line}>진행중 <b>${inFlight.length}건</b> 중 <b>${STALE_DAYS}일</b> 넘게 멈춘 건이 ` +
    `${red(`<b>${stalled.length}건</b>`)} 입니다.</div>`;

  for (const [pic, rows] of byPic(stalled)) {
    b += rule(`${esc(pic)} — ${rows.length}건`);
    for (const r of rows) {
      b += `<div ${line}>&nbsp;&nbsp;${red(`<b>${r.days}일</b>`)} &nbsp; ${r.progress}% &nbsp; ` +
        `<b>${esc(r.project)}</b> &nbsp;${dim(esc(stageOf(r)))}` +
        `${r.impact === 'High' ? ' &nbsp;<b>High</b>' : ''}</div>`;
    }
  }

  // Never got past the NDA. These are the ones most likely to be dead rather than slow.
  const nda = stalled.filter((r) => r.progress <= 20);
  if (nda.length) {
    b += rule('확인 필요');
    b += `<div ${line}>NDA만 찍고 멈춘 ${nda.length}건 — ${nda
      .map((r) => esc(r.project))
      .join(' · ')}</div>`;
    b += `<div ${line}>살아있는 건인지 확인 부탁드립니다. 아니라면 <b>Hold/Drop</b> 처리해야 ` +
      `"진행중 ${inFlight.length}건"이 의미를 갖습니다.</div>`;
  }

  b += foot(`라이브·미착수 제외, 진행중 ${inFlight.length}건만 집계 · 매주 자동 생성`);
  return wrap(b);
}

/* ------------------------------------------------------------------ 3. leaders */
/**
 * The directors' room: 대표 · CSO · CTO and the line directors.
 *
 * They are not chasing partners, so a list of them is the wrong output. What this has
 * to answer is which of the five business lines is actually running, which is stalled,
 * and what the shape implies about where the next quarter's engineering goes.
 *
 * Live rows count here, unlike the other two messages. "Twenty-nine of our thirty live
 * integrations are on one line" is the finding - it is invisible if you only look at
 * what moved this week.
 */

/** Sheet category -> business line. Anything unmapped still shows, under its own name. */
const LINES = [
  { key: 'Channel API', label: '고객사 연동', gloss: '우리 재고를 파는 채널' },
  { key: '3rd Party Hotel', label: '공급사 연동', gloss: '재고를 가져오는 소스' },
  { key: 'Switching System', label: '스위칭 연동', gloss: '한 건이 파트너 다수를 여는 경로' },
  { key: '3rd Party Activity', label: '액티비티 공급사', gloss: '' },
  { key: 'CRS', label: 'CRS', gloss: '' },
];
/** Lines that bring inventory in, as opposed to selling it. */
const SUPPLY = ['3rd Party Hotel', '3rd Party Activity', 'CRS'];

function lineStats() {
  const seen = new Set(LINES.map((l) => l.key));
  const extra = [...new Set(data.rows.map((r) => r.category))]
    .filter((c) => !seen.has(c))
    .map((c) => ({ key: c, label: c, gloss: '' }));

  return [...LINES, ...extra]
    .map((l) => {
      const rows = data.rows.filter((r) => r.category === l.key);
      const live = rows.filter((r) => r.progress >= 100);
      const inf = rows.filter((r) => r.progress > 0 && r.progress < 100);
      return {
        ...l,
        rows,
        n: rows.length,
        live: live.length,
        inflight: inf.length,
        stalled: inf.filter((r) => r.days !== null && r.days >= STALE_DAYS).length,
        idle: rows.length - live.length - inf.length,
        omh: rows.filter((r) => ['direct', 'shared'].includes(r.route)).length,
        conv: rows.length ? Math.round((live.length / rows.length) * 100) : 0,
      };
    })
    .filter((l) => l.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** Partners that appear on more than one line - selling to us and buying from us. */
function twoWay() {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = new Map();
  for (const r of data.rows) {
    const k = norm(r.project);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()]
    .filter((v) => v.length > 1 && new Set(v.map((r) => r.category)).size > 1)
    .sort((a, b) => Math.max(...b.map((r) => r.progress)) - Math.max(...a.map((r) => r.progress)));
}

function leadersMessage() {
  const lines = lineStats();
  const totalLive = data.rows.filter((r) => r.progress >= 100).length;
  const idle = data.rows.filter((r) => r.progress === 0).length;

  let b = title(`&#128225; Integration Tracker &mdash; 라인별 현황 (${shortDate(stamp)})`);
  b += `<div ${line}>전체 <b>${data.rows.length}건</b> · 라이브 <b>${totalLive}</b> · ` +
    `진행중 <b>${inFlight.length}</b> (${STALE_DAYS}일+ 정체 ${red(`${stalled.length}`)}) · 미착수 <b>${idle}</b></div>`;

  /* ---- the five lines, side by side ---- */
  const th = `style="${FONT};font-size:12px;color:#666;font-weight:600;text-align:right;padding:4px 8px;border-bottom:1px solid #ddd"`;
  const td = `style="${FONT};font-size:14px;text-align:right;padding:5px 8px;border-bottom:1px solid #eee"`;
  const tdL = `style="${FONT};font-size:14px;text-align:left;padding:5px 8px;border-bottom:1px solid #eee"`;

  b += rule('라인별');
  b += `<table style="border-collapse:collapse;margin:2px 0 0 0">
    <tr>
      <th ${th} style="text-align:left">라인</th><th ${th}>총</th><th ${th}>라이브</th>
      <th ${th}>진행중</th><th ${th}>미착수</th><th ${th}>전환율</th><th ${th}>OMH 구현</th>
    </tr>`;
  for (const l of lines) {
    const stall = l.stalled ? ` ${red(`(정체 ${l.stalled})`)}` : '';
    const conv = l.conv === 0 ? red('0%') : `${l.conv}%`;
    b += `<tr>
      <td ${tdL}><b>${esc(l.label)}</b>${l.gloss ? ` ${dim(esc(l.gloss))}` : ''}</td>
      <td ${td}>${l.n}</td><td ${td}><b>${l.live}</b></td>
      <td ${td}>${l.inflight}${stall}</td><td ${td}>${l.idle}</td>
      <td ${td}>${conv}</td><td ${td}>${l.omh}</td>
    </tr>`;
  }
  b += '</table>';

  /* ---- what the shape says ---- */
  const top = lines.slice().sort((a, b2) => b2.live - a.live)[0];
  if (top && totalLive > 0 && top.live / totalLive >= 0.8) {
    const rest = totalLive - top.live;
    b += rule('매출이 한 라인에 실려 있습니다');
    b += `<div ${line}>라이브 ${totalLive}건 중 <b>${top.live}건이 ${esc(top.label)}</b>입니다. ` +
      `나머지 ${lines.length - 1}개 라인을 다 합쳐서 ${rest}건.</div>`;
    b += `<div ${line}>파는 창구는 ${top.live}개, 재고를 가져오는 소스는 ` +
      `${lines.filter((l) => SUPPLY.includes(l.key)).reduce((s, l) => s + l.live, 0)}개입니다. ` +
      `채널을 더 붙일수록 같은 재고를 더 많은 창구에 나눠 파는 구조가 됩니다.</div>`;
  }

  const sw = lines.find((l) => l.key === 'Switching System');
  if (sw && sw.live === 0) {
    // A switching platform carries many partners behind one integration, so rows already
    // routed through one are the concrete prize for opening it.
    const behind = data.rows.filter((r) => r.route === 'switching' && r.progress < 100);
    const highIdle = sw.rows.filter((r) => r.progress === 0 && r.impact === 'High').map((r) => r.project);
    b += rule('스위칭 라이브 0건 — 미실현 레버리지');
    b += `<div ${line}>스위칭 1건이 열리면 그 뒤의 파트너들이 개별 연동 없이 들어옵니다. ` +
      `현재 ${sw.n}건 중 라이브 ${red('0')}, 진행중 ${sw.inflight}.</div>`;
    if (behind.length) {
      b += `<div ${line}>이미 "스위칭 경유"로 분류된 건이 <b>${behind.length}건</b> — ` +
        `${behind.map((r) => esc(r.project)).join(' · ')}. 스위칭이 열리면 개별 개발 없이 해결됩니다.</div>`;
    }
    if (highIdle.length) b += `<div ${line}>미착수 High: <b>${highIdle.map(esc).join(' · ')}</b>. 착수 여부가 물량 확대의 분기점입니다.</div>`;
  }

  const supply = lines.filter((l) => SUPPLY.includes(l.key));
  const sN = supply.reduce((s, l) => s + l.n, 0);
  const sOmh = supply.reduce((s, l) => s + l.omh, 0);
  const sLive = supply.reduce((s, l) => s + l.live, 0);
  if (sN && sOmh / sN >= 0.7) {
    b += rule('공급 라인은 열면 전부 우리 개발입니다');
    b += `<div ${line}>공급 ${sN}건 중 <b>${sOmh}건이 OMH 직접 구현</b>입니다. ` +
      `고객사 연동은 상대가 우리 API에 붙지만, 공급사는 우리가 상대 API에 붙어야 하기 때문입니다.</div>`;
    b += `<div ${line}>지금 라이브 ${sLive}건. 이 라인을 여는 결정은 ` +
      `<b>개발 인력 확보 결정</b>과 같습니다 — 현재 개발이 실제로 붙어 있는 건은 ${devWork.length}건뿐입니다.</div>`;
  }

  const both = twoWay();
  if (both.length) {
    b += rule('사고팔기를 함께 하는 상대');
    b += `<div ${line}>${both.length}곳이 두 라인에 걸쳐 있습니다 — ` +
      `${both.map((v) => `<b>${esc(v[0].project)}</b> ${dim(v.map((r) => `${r.progress}%`).join('/'))}`).join(' · ')}</div>`;
    const cold = both.filter((v) => v.every((r) => r.progress === 0));
    if (cold.length) {
      b += `<div ${line}>이 중 ${cold.map((v) => esc(v[0].project)).join(' · ')}는 양쪽 다 미착수입니다. ` +
        `한 번의 협상으로 두 라인이 열리는 건이라 개별 건보다 우선순위가 높습니다.</div>`;
    }
  }

  /* ---- what to decide ---- */
  const advanced = stalled.filter((r) => r.progress >= 50).sort((a, b2) => b2.progress - a.progress);
  if (advanced.length) {
    b += rule('판단 필요 — 절반 넘게 진행됐는데 멈춘 건');
    for (const r of advanced) {
      const who =
        r.watch === 'omhbuild' ? 'OMH 구현'
        : r.watch === 'omhsupport' ? 'OMH 지원'
        : r.watch === 'partnerbuild' ? '파트너 구현 대기'
        : '영업 단계';
      b += `<div ${line}><b>${esc(r.project)}</b> &nbsp;${r.progress}% &nbsp;${red(`${r.days}일`)} ` +
        `&nbsp;${dim(`${who} · ${r.pic || '-'}`)}</div>`;
    }
  }

  // Stalls on a line that never moves do not show up as stalls. Say so, or "정체 0" reads
  // as health when it means the opposite.
  const frozen = lines.filter((l) => l.inflight === 0 && l.n > 0);
  if (frozen.length) {
    b += `<div ${line}>${frozen.map((l) => esc(l.label)).join(' · ')}는 진행중 0건이라 정체로도 잡히지 않습니다 — ` +
      `${dim('움직이지 않으면 알럿도 울리지 않습니다')}.</div>`;
  }

  const gaps = [];
  if (data.counts?.hasTarget && (data.counts.withTarget ?? 0) === 0) gaps.push('목표 오픈일');
  if (data.counts?.hasBlocker && (data.counts.withBlocker ?? 0) === 0) gaps.push('블로커');
  const noImpact = data.rows.length - (data.counts?.withImpact ?? 0);
  if (gaps.length || noImpact) {
    b += rule('판단 근거의 공백');
    if (gaps.length) b += `<div ${line}>${gaps.join(' · ')} 컬럼이 비어 있어 지연 여부와 정체 사유를 표시할 수 없습니다.</div>`;
    if (noImpact) b += `<div ${line}>Biz Impact 미입력 <b>${noImpact}/${data.rows.length}건</b> — 우선순위 근거가 절반입니다.</div>`;
  }

  b += foot(`매주 자동 생성 · 정체 기준 ${STALE_DAYS}일 · 라인 구분은 시트 Category 기준`);
  return wrap(b);
}

/* ------------------------------------------------------------------ write */
fs.mkdirSync(OUT, { recursive: true });

const files = [
  ['dev', devMessage()],
  ['sales', salesMessage()],
  ['leaders', leadersMessage()],
].map(([kind, html]) => {
  const file = path.join(OUT, `teams-tracker-${kind}-${stamp}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return { kind, file, size: html.length };
});

console.log(`\n  In-flight ${inFlight.length}  ·  stalled ${STALE_DAYS}d+ ${stalled.length}  ·  OMH work ${devWork.length}  ·  partner wait ${partnerWait.length}\n`);
for (const f of files) {
  console.log(`  ${CH[f.kind].padEnd(22)} ${path.relative(root, f.file)}  (${f.size} chars)`);
}
console.log('\n  Nothing sent. To post one:');
console.log(`    node scripts/post-teams.js msg "${CH.dev}" "<file>" --send\n`);
