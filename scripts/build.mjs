/**
 * Excel -> JSON. The only build step in this project.
 *
 * Reads data/Dev_Schedule.xlsx (the "Dev Tracker" sheet) and writes data/tracker.json,
 * which index.html loads. Excel stays the source of truth; nothing is edited on the web.
 *
 * Run:  npm run build      (or double-click update.bat on Windows)
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
const SHEET = 'Dev Tracker';
const HEADER_ROW = 3; // 1-based row holding the column names

/** The 11 stage columns, in order, with the progress weight the sheet already uses. */
const STAGES = [
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
];

/** Excel serial number or Date -> yyyy-mm-dd. */
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

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' || text === '??' ? null : text;
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

function daysBetween(isoDate, today) {
  if (!isoDate) return null;
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.round((today - then) / 86_400_000);
}

/* ------------------------------------------------------------------ read */
if (!fs.existsSync(SOURCE)) {
  console.error(`\nMissing ${path.relative(root, SOURCE)}`);
  console.error('Drop the Dev Schedule workbook there (named Dev_Schedule.xlsx) and run this again.\n');
  process.exit(1);
}

const workbook = XLSX.readFile(SOURCE, { cellDates: true });
if (!workbook.SheetNames.includes(SHEET)) {
  console.error(`\nThe workbook has no "${SHEET}" sheet. Found: ${workbook.SheetNames.join(', ')}\n`);
  process.exit(1);
}

const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], { header: 1, raw: true, defval: null });
const headers = (grid[HEADER_ROW - 1] ?? []).map((h) => (h === null ? '' : String(h).trim()));
const columnOf = (name) => headers.indexOf(name);

const IDX = {
  no: columnOf('No.'),
  status: columnOf('Status'),
  project: columnOf('Project'),
  category: columnOf('Category'),
  impact: columnOf('Biz Impact'),
  devLoad: columnOf('OHMY Dev Load'),
  switching: columnOf('Switching'),
  team: columnOf('Handling Team'),
  pic: columnOf('PIC (Sales)'),
  lastActivity: columnOf('Last Activity'),
  delay: columnOf('Delay Check'),
};

if (IDX.project < 0) {
  console.error(`\nCould not find the "Project" column on row ${HEADER_ROW}. Has the sheet layout changed?\n`);
  process.exit(1);
}

const stageIndex = STAGES.map((stage) => ({ ...stage, index: columnOf(stage.column) }));
const missingStages = stageIndex.filter((s) => s.index < 0).map((s) => s.column);
if (missingStages.length) {
  console.warn(`Warning: stage columns not found and will be blank: ${missingStages.join(', ')}`);
}

/* ------------------------------------------------------------------ transform */
const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const rows = [];

for (let r = HEADER_ROW; r < grid.length; r += 1) {
  const raw = grid[r] ?? [];
  const project = clean(raw[IDX.project]);
  if (!project) continue;

  const stages = stageIndex.map((stage) => ({
    n: stage.n,
    label: stage.label,
    short: stage.short,
    weight: stage.weight,
    date: stage.index >= 0 ? toISODate(raw[stage.index]) : null,
  }));

  // Progress is the weight of the furthest stage that carries a date — the sheet's own rule.
  const reached = stages.filter((s) => s.date);
  const progress = reached.length ? Math.max(...reached.map((s) => s.weight)) : 0;
  const currentStage = reached.length ? reached.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;

  const lastActivity = toISODate(raw[IDX.lastActivity]);
  const days = daysBetween(lastActivity, today);
  const status = clean(raw[IDX.status]) ?? 'Contact';
  const done = status === 'Live';

  // Recomputed from today, so the board never shows a stale "days elapsed" from the sheet.
  let health = 'ok';
  if (done) health = 'live';
  else if (lastActivity === null) health = 'norecord';
  else if (days > 90) health = 'stalled90';
  else if (days > 30) health = 'stalled30';
  else if (days > 14) health = 'watch';

  const devLoad = parseDevLoad(raw[IDX.devLoad]);

  // Attention rank drives the default sort. A finished integration whose last activity was
  // years ago is not "stalled" — it is done — so Live always sinks to the bottom.
  const RANK = { stalled90: 0, stalled30: 1, watch: 2, norecord: 3, ok: 4, live: 5 };

  rows.push({
    rank: RANK[health],
    no: raw[IDX.no] ?? rows.length + 1,
    project,
    status,
    category: clean(raw[IDX.category]) ?? 'Uncategorised',
    impact: clean(raw[IDX.impact]),
    devLoad: devLoad.level,
    devLoadLabel: devLoad.label,
    switching: clean(raw[IDX.switching]),
    team: clean(raw[IDX.team]),
    pic: clean(raw[IDX.pic]),
    lastActivity,
    days,
    health,
    delayNote: clean(raw[IDX.delay]),
    progress,
    currentStage: currentStage ? currentStage.label : null,
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
  stageModel: STAGES.map(({ n, label, short, weight }) => ({ n, label, short, weight })),
  counts: {
    total: rows.length,
    byStatus: stats('status'),
    byCategory: stats('category'),
    byHealth: stats('health'),
  },
  rows,
};

fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 1));

// Also emit a plain script that assigns the same payload to window.TRACKER, so the board
// opens by double-clicking index.html — no server, no fetch, no CORS.
fs.writeFileSync(
  path.join(root, 'data', 'tracker.js'),
  `/* Generated by scripts/build.mjs — do not edit. */
window.TRACKER = ${JSON.stringify(payload)};
`,
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
console.log(`\n  ${rows.length} projects  ->  data/tracker.json (${size} kB)`);
console.log(`  status:  ${Object.entries(payload.counts.byStatus).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
console.log(`  health:  ${Object.entries(payload.counts.byHealth).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
console.log('\n  Done. Commit and push, and the board updates.\n');
