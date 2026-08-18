/**
 * Excel -> JSON. The only build step in this project.
 *
 * Reads data/Dev_Schedule.xlsx (the "Dev Tracker (IT)" sheet) and writes
 * data/tracker.json plus data/tracker.js, which index.html loads directly.
 * Excel stays the source of truth; nothing is edited on the web.
 *
 * The sheet already computes several things the board used to infer — current stage,
 * next gate, dev owner, API direction. Those are read straight through rather than
 * guessed at. Only "days since last activity" is recomputed, because the sheet's own
 * value goes stale the moment it is saved.
 *
 * Run: npm run build   (or npm run weekly, or double-click update.bat)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

// The ESM build of SheetJS does not wire up Node's fs by itself.
XLSX.set_fs(fs);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'data', 'Dev_Schedule.xlsx');
const OUTPUT = path.join(root, 'data', 'tracker.json');
const HEADER_ROW = 3; // 1-based row holding the column names

/** Sheet names tried in order, so an older workbook still builds. */
const SHEET_CANDIDATES = ['Dev Tracker (IT)', 'Dev Tracker'];

/**
 * The workbook has appeared in two shapes. The newer "Dev Tracker (IT)" sheet runs 12
 * milestones from a 10% first contact; the older "Dev Tracker" sheet starts at NDA and
 * has 11. Both are supported and the right one is chosen by looking at the header row,
 * so whichever version lands in the CRM folder on a given week still builds.
 */
const STAGE_SETS = {
  twelve: [
    { n: 1, column: '① 미팅/1st Contact (10%)', label: '1st Contact', short: 'Contact', weight: 10 },
    { n: 2, column: '② NDA 체결 (20%)', label: 'NDA Signed', short: 'NDA', weight: 20 },
    { n: 3, column: '③ 계약 체결 (30%)', label: 'Contract Signed', short: 'Contract', weight: 30 },
    { n: 4, column: '④ SLA 확정 (40%)', label: 'SLA Finalized', short: 'SLA', weight: 40 },
    { n: 5, column: '⑤ 개발 착수 예정 (45%)', label: 'Dev Kickoff Planned', short: 'Kickoff', weight: 45 },
    { n: 6, column: '⑥ 개발 착수/SPEC·DEV Key (50%)', label: 'Dev Kickoff / SPEC / DEV Key', short: 'Dev', weight: 50 },
    { n: 7, column: '⑦ Certification (60%)', label: 'Certification', short: 'Cert', weight: 60 },
    { n: 8, column: '⑧ Live Test (70%)', label: 'Live Test', short: 'Test', weight: 70 },
    { n: 9, column: '⑨ 개발 완료 예정 (75%)', label: 'Dev Completion Planned', short: 'Complete', weight: 75 },
    { n: 10, column: '⑩ Live Open (80%)', label: 'Live Open', short: 'Open', weight: 80 },
    { n: 11, column: '⑪ 첫 부킹 (90%)', label: 'First Booking', short: 'Booking', weight: 90 },
    { n: 12, column: '⑫ API Live 완료 (100%)', label: 'API Live Complete', short: 'Live', weight: 100 },
  ],
  eleven: [
    { n: 1, column: '① NDA Signed (20%)', label: 'NDA Signed', short: 'NDA', weight: 20 },
    { n: 2, column: '② Contract Signed (30%)', label: 'Contract Signed', short: 'Contract', weight: 30 },
    { n: 3, column: '③ SLA Finalized (40%)', label: 'SLA Finalized', short: 'SLA', weight: 40 },
    { n: 4, column: '④ Dev Kickoff Planned (45%)', label: 'Dev Kickoff Planned', short: 'Kickoff', weight: 45 },
    { n: 5, column: '⑤ Dev Kickoff / SPEC·DEV Key (50%)', label: 'Dev Kickoff / SPEC / DEV Key', short: 'Dev', weight: 50 },
    { n: 6, column: '⑥ Certification (60%)', label: 'Certification', short: 'Cert', weight: 60 },
    { n: 7, column: '⑦ Live Test (70%)', label: 'Live Test', short: 'Test', weight: 70 },
    { n: 8, column: '⑧ Dev Completion Planned (75%)', label: 'Dev Completion Planned', short: 'Complete', weight: 75 },
    { n: 9, column: '⑨ Live Open (80%)', label: 'Live Open', short: 'Open', weight: 80 },
    { n: 10, column: '⑩ First Booking (90%)', label: 'First Booking', short: 'Booking', weight: 90 },
    { n: 11, column: '⑪ API Live Complete (100%)', label: 'API Live Complete', short: 'Live', weight: 100 },
  ],
};

/**
 * Columns are matched by name, not position, and each field lists every header the
 * workbook has used. A reordered sheet, a renamed column or a newly inserted one (the
 * latest file added Country in third place) all keep working.
 */
const COLUMNS = {
  no: ['No.'],
  category: ['Category'],
  project: ['Project'],
  country: ['Country'],
  direction: ['연동 방향 (API Direction)'],
  impact: ['Biz Impact'],
  devLoad: ['OHMY 개발 부하', 'OHMY Dev Load'],
  devOwner: ['개발 주체 (Dev Owner)'],
  switching: ['Switching'],
  team: ['담당팀', 'Handling Team'],
  pic: ['PIC (Sales)'],
  status: ['Status'],
  plannedStart: ['계획 시작'],
  plannedEnd: ['계획 종료'],
  progress: ['진행율', 'Progress %'],
  currentStage: ['현재 단계'],
  nextGate: ['다음 게이트'],
  lastActivity: ['최근 활동일', 'Last Activity'],
  delay: ['지연 체크', 'Delay Check'],
  itOwner: ['IT 담당자'],
  blocker: ['현재 블로커 / 이슈'],
  note: ['비고'],
  consistency: ['Status vs 날짜 정합성'],
};

/* ---------------------------------------------------------------- helpers */
function toISODate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}`;
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Trim, collapse the newlines the sheet embeds in headers and cells, drop placeholders. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' || text === '??' || text === '-' ? null : text;
}

/** "🔴 Full (100%)" -> { level: 'full', label: 'Full (100%)' } */
function parseDevLoad(value) {
  const text = clean(value);
  if (!text) return { level: 'none', label: '—' };
  const label = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  if (/full/i.test(text)) return { level: 'full', label };
  if (/half/i.test(text)) return { level: 'half', label };
  if (/minimal/i.test(text)) return { level: 'minimal', label };
  return { level: 'none', label: label || '—' };
}

/** "→ OMH API 제공 (…)" -> 'outbound' (partner calls us) / "← 고객사 API 연동" -> 'inbound'. */
function parseDirection(value) {
  const text = clean(value);
  if (!text) return { key: 'unknown', label: '—' };
  if (text.startsWith('→')) return { key: 'provide', label: text.replace(/^→\s*/, '') };
  if (text.startsWith('←')) return { key: 'consume', label: text.replace(/^←\s*/, '') };
  return { key: 'unknown', label: text };
}

/** Strip the circled number and percentage the sheet decorates stage names with. */
function stageLabelOf(value) {
  const text = clean(value);
  if (!text) return null;
  if (/미추적|기록 없음/.test(text)) return null;
  const matched = STAGES.find((s) => text.includes(s.column) || s.column.includes(text));
  return matched ? matched.label : text.replace(/^[①-⑫]\s*/, '').replace(/\s*\(\d+%\)$/, '');
}

/**
 * Older sheets carry a Switching column; the newer one dropped it and the platform
 * shows up inside Dev Owner instead ("OHMY/ TGX", "Shiji or OHMY"). Prefer the column.
 */
const SWITCH_PLATFORMS = ['TGX', 'Shiji', 'SHIJI', 'Travelgate', 'Derbysoft', 'Juniper'];
function parseSwitching(column, devOwner) {
  const explicit = clean(column);
  if (explicit) return explicit;
  if (!devOwner) return null;
  const hit = SWITCH_PLATFORMS.find((p) => new RegExp(p, 'i').test(devOwner));
  return hit ? (hit.toLowerCase() === 'shiji' ? 'SHIJI' : hit) : null;
}

function daysBetween(isoDate, today) {
  if (!isoDate) return null;
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.round((today - then) / 86_400_000);
}

/* ---------------------------------------------------------------- read */
if (!fs.existsSync(SOURCE)) {
  console.error(`\nMissing ${path.relative(root, SOURCE)}`);
  console.error('Drop the Dev Schedule workbook there (named Dev_Schedule.xlsx) and run this again.\n');
  process.exit(1);
}

const workbook = XLSX.readFile(SOURCE, { cellDates: true });
const SHEET = SHEET_CANDIDATES.find((name) => workbook.SheetNames.includes(name));
if (!SHEET) {
  console.error(`\nNo tracker sheet found. Looked for: ${SHEET_CANDIDATES.join(', ')}`);
  console.error(`The workbook has: ${workbook.SheetNames.join(', ')}\n`);
  process.exit(1);
}

const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], { header: 1, raw: true, defval: null });
const headers = (grid[HEADER_ROW - 1] ?? []).map((h) => (h === null ? '' : String(h).replace(/\s+/g, ' ').trim()));
const columnOf = (name) => headers.indexOf(String(name).replace(/\s+/g, ' ').trim());

const IDX = Object.fromEntries(
  Object.entries(COLUMNS).map(([key, names]) => {
    const found = names.map(columnOf).find((i) => i >= 0);
    return [key, found === undefined ? -1 : found];
  }),
);

// Whichever milestone layout matches more of this header row is the one in use.
const matches = (set) => set.filter((stage) => columnOf(stage.column) >= 0).length;
const [setName, STAGES] = matches(STAGE_SETS.twelve) >= matches(STAGE_SETS.eleven)
  ? ['twelve', STAGE_SETS.twelve]
  : ['eleven', STAGE_SETS.eleven];

if (IDX.project < 0) {
  console.error(`\nNo "Project" column on row ${HEADER_ROW} of "${SHEET}". Has the layout changed?`);
  console.error(`Found: ${headers.filter(Boolean).slice(0, 12).join(' | ')}\n`);
  process.exit(1);
}

const stageIndex = STAGES.map((stage) => ({ ...stage, index: columnOf(stage.column) }));
const missingStages = stageIndex.filter((s) => s.index < 0);
if (missingStages.length) {
  console.warn(`Warning: stage columns not found, they will be blank: ${missingStages.map((s) => s.column).join(', ')}`);
}

const missingOptional = Object.entries(IDX).filter(([, i]) => i < 0).map(([k]) => k);
if (missingOptional.length) console.warn(`Note: columns not present in this workbook: ${missingOptional.join(', ')}`);

/* ---------------------------------------------------------------- transform */
const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const rows = [];
const at = (raw, key) => (IDX[key] >= 0 ? raw[IDX[key]] : null);

for (let r = HEADER_ROW; r < grid.length; r += 1) {
  const raw = grid[r] ?? [];
  const project = clean(at(raw, 'project'));
  if (!project) continue;

  const stages = stageIndex.map((stage) => ({
    n: stage.n,
    label: stage.label,
    short: stage.short,
    weight: stage.weight,
    date: stage.index >= 0 ? toISODate(raw[stage.index]) : null,
  }));

  // Trust the sheet's own progress when it has one; otherwise take the furthest stage
  // that carries a date. Both land on the same number, but the sheet wins on ties.
  const reached = stages.filter((s) => s.date);
  const sheetProgress = at(raw, 'progress');
  const derived = reached.length ? Math.max(...reached.map((s) => s.weight)) : 0;
  const progress =
    typeof sheetProgress === 'number' && sheetProgress > 0 ? Math.round(sheetProgress * 100) : derived;

  const lastActivity = toISODate(at(raw, 'lastActivity'));
  const days = daysBetween(lastActivity, today);
  const status = clean(at(raw, 'status')) ?? 'Contact';

  // Only the milestones decide whether something is finished. The Status column says
  // "Live" on eight rows whose dates stop at 45-70%, and treating those as done hid a
  // 268-day silence behind a green label. The sheet flags the contradiction itself.
  const consistency = clean(at(raw, 'consistency'));
  const consistent = !consistency || consistency === 'OK';
  const done = progress >= 100;

  // Recomputed from today, so the board is never wrong just because the sheet is old.
  let health = 'ok';
  if (done) health = 'live';
  else if (lastActivity === null) health = 'norecord';
  else if (days > 90) health = 'stalled90';
  else if (days > 30) health = 'stalled30';
  else if (days > 14) health = 'watch';

  const RANK = { stalled90: 0, stalled30: 1, watch: 2, norecord: 3, ok: 4, live: 5 };
  const devLoad = parseDevLoad(at(raw, 'devLoad'));
  const direction = parseDirection(at(raw, 'direction'));
  const devOwner = clean(at(raw, 'devOwner'));

  rows.push({
    rank: RANK[health],
    no: at(raw, 'no') ?? rows.length + 1,
    project,
    status,
    category: clean(at(raw, 'category')) ?? 'Uncategorised',
    country: clean(at(raw, 'country')),
    impact: clean(at(raw, 'impact')),
    devLoad: devLoad.level,
    devLoadLabel: devLoad.label,
    devOwner,
    direction: direction.key,
    directionLabel: direction.label,
    switching: parseSwitching(at(raw, 'switching'), devOwner),
    team: clean(at(raw, 'team')),
    pic: clean(at(raw, 'pic')),
    itOwner: clean(at(raw, 'itOwner')),
    plannedStart: clean(at(raw, 'plannedStart')),
    plannedEnd: clean(at(raw, 'plannedEnd')),
    lastActivity,
    days,
    health,
    delayNote: clean(at(raw, 'delay')),
    consistency,
    consistent,
    blocker: clean(at(raw, 'blocker')),
    note: clean(at(raw, 'note')),
    progress,
    // The sheet authors both of these; the board shows them rather than second-guessing.
    currentStage: stageLabelOf(at(raw, 'currentStage')) ?? (reached.length ? reached[reached.length - 1].label : null),
    nextGate: stageLabelOf(at(raw, 'nextGate')),
    stages,
  });
}

const stats = (key) =>
  rows.reduce((acc, row) => {
    const value = row[key] ?? '—';
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});

const payload = {
  generatedAt: new Date().toISOString(),
  sourceFile: path.basename(SOURCE),
  sourceSheet: SHEET,
  sourceModified: fs.statSync(SOURCE).mtime.toISOString(),
  stageLayout: setName,
  stageModel: STAGES.map(({ n, label, short, weight }) => ({ n, label, short, weight })),
  counts: {
    total: rows.length,
    byStatus: stats('status'),
    byCategory: stats('category'),
    byHealth: stats('health'),
    withImpact: rows.filter((r) => r.impact).length,
    withDevOwner: rows.filter((r) => r.devOwner).length,
    inconsistent: rows.filter((r) => !r.consistent).length,
    // Whether the sheet carries the column at all — 0 mismatches because the check
    // does not exist is a different statement from 0 mismatches because it passed.
    hasConsistency: IDX.consistency >= 0,
  },
  rows,
};

fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 1));

// Also emit a plain script that assigns the same payload to window.TRACKER, so the board
// opens by double-clicking index.html — no server, no fetch, no CORS.
fs.writeFileSync(
  path.join(root, 'data', 'tracker.js'),
  `/* Generated by scripts/build.mjs — do not edit. */\nwindow.TRACKER = ${JSON.stringify(payload)};\n`,
);

// ---------------------------------------------------------------- cache busting
// GitHub Pages serves every asset with max-age=600, so after an update a returning
// visitor can get the new index.html against a cached app.js and see a half-rendered
// page for ten minutes. Stamping the build time onto each asset URL makes each deploy
// a new URL, so the browser always fetches a matching set.
const stamp = payload.generatedAt.replace(/[-:]/g, '').slice(0, 13); // 20260818T1352
const indexPath = path.join(root, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const before = html;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const asset of ['styles.css', 'data/tracker.js', 'i18n.js', 'app.js']) {
  const pattern = new RegExp(`((?:src|href)=")${escapeRe(asset)}(\\?v=[^"]*)?(")`, 'g');
  html = html.replace(pattern, `$1${asset}?v=${stamp}$3`);
}

if (html !== before) {
  fs.writeFileSync(indexPath, html);
  console.log(`  asset version stamped: ?v=${stamp}`);
}

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
console.log(`\n  ${rows.length} projects from "${SHEET}" (${STAGES.length}-stage layout)  ->  data/tracker.json (${size} kB)`);
console.log(`  status:  ${Object.entries(payload.counts.byStatus).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
console.log(`  health:  ${Object.entries(payload.counts.byHealth).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);

// Two columns drive the dashboard's prioritisation. Say plainly when they are empty
// rather than letting the board present an empty column as a finding.
if (payload.counts.inconsistent > 0) {
  console.warn(`
  NOTE: ${payload.counts.inconsistent} rows where Status disagrees with the milestone dates.`);
}

if (payload.counts.withImpact === 0) {
  console.warn(`\n  NOTE: Biz Impact is empty on all ${rows.length} rows.`);
  console.warn('        The effort x impact matrix will read every project as "low impact".');
} else if (payload.counts.withImpact < rows.length) {
  console.warn(`\n  NOTE: Biz Impact is set on only ${payload.counts.withImpact} of ${rows.length} rows.`);
}

console.log('\n  Done. Commit and push, and the board updates.\n');
