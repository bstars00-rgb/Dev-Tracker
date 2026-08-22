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
// The shape of the problem and what needs deciding. No row-by-row listing - the two
// worst cases and the counts carry it.
function leadersMessage() {
  let b = title(`&#128225; Integration Tracker (${shortDate(stamp)})`);

  b += `<div ${line}>진행중 <b>${inFlight.length}건</b> · 최근 움직임 ${moving.length}건 · ` +
    `${STALE_DAYS}일+ 정체 ${red(`<b>${stalled.length}건</b>`)}</div>`;

  const owed = devWork.length;
  b += `<div ${line}>이 중 OMH 개발이 붙어야 하는 건 <b>${owed}건</b>, ` +
    `파트너 구현 대기 <b>${partnerWait.length}건</b>입니다.</div>`;

  // Sorting the stall list purely by age puts two long-dead 20% prospects at the top,
  // which is the least useful thing a leader can be handed. What costs money is an
  // integration that got most of the way and then stopped, so that leads.
  const advanced = stalled.filter((r) => r.progress >= 50).sort((a, b) => b.progress - a.progress);
  if (advanced.length) {
    b += rule('판단 필요 — 절반 넘게 진행됐는데 멈춘 건');
    for (const r of advanced) {
      const who =
        r.watch === 'omhbuild' ? 'OMH 구현'
        : r.watch === 'omhsupport' ? 'OMH 지원'
        : r.watch === 'partnerbuild' ? '파트너 구현 대기'
        : '영업 단계';
      b += `<div ${line}><b>${esc(r.project)}</b> &nbsp;${r.progress}% &nbsp;${red(
        `${r.days}일`,
      )} &nbsp;${dim(`${who} · ${r.pic || '-'}`)}</div>`;
    }
    b += `<div ${line}>신규 착수보다 이쪽을 푸는 게 우선이라고 봅니다.</div>`;
  }

  // The other kind of stall: never got past the NDA. Not urgent, but it inflates the
  // in-flight number until someone decides they are dead.
  const nda = stalled.filter((r) => r.progress <= 30);
  if (nda.length) {
    b += rule('오래 방치 — NDA·계약 단계');
    const oldest = nda[0];
    b += `<div ${line}>${nda.length}건, 최장 ${red(`${oldest.days}일`)} (${esc(oldest.project)}). ` +
      `Hold/Drop 정리가 없으면 "진행중 ${inFlight.length}건"이 실제보다 커 보입니다.</div>`;
  }

  const byOwner = byPic(stalled);
  if (byOwner.length) {
    b += rule('담당별 정체 건수');
    b += `<div ${line}>${byOwner.map(([pic, rows]) => `${esc(pic)} ${rows.length}건`).join(' · ')}</div>`;
  }

  // The board can only answer "is this late?" once someone fills the target dates in.
  const gaps = [];
  if (data.counts?.hasTarget && (data.counts.withTarget ?? 0) === 0) gaps.push('목표 오픈일');
  if (data.counts?.hasDevOwner && (data.counts.withDevOwner ?? 0) === 0) gaps.push('개발 주체');
  if (data.counts?.hasBlocker && (data.counts.withBlocker ?? 0) === 0) gaps.push('블로커');
  if (gaps.length) {
    b += rule('데이터 공백');
    b += `<div ${line}>${gaps.join(' · ')} 컬럼이 비어 있어 지연 여부와 담당 구분을 ` +
      `추정으로만 표시하고 있습니다.</div>`;
  }

  b += foot(`라이브 ${data.rows.filter((r) => r.progress >= 100).length}건 · 미착수 ${
    data.rows.filter((r) => r.progress === 0).length
  }건 제외 · 매주 자동 생성`);
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
