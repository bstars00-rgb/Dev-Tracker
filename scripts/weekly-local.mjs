/**
 * One command for the weekly refresh, run from a PC.
 *
 *   npm run weekly
 *   npm run weekly -- --source "C:/path/to/CRM_Dev.xlsx"
 *   npm run weekly -- --no-push
 *
 * With --source it copies that workbook in first, which is how this hooks into the
 * existing local pipeline: whatever already downloaded the file from SharePoint hands
 * over the path, and nothing here needs its own Graph credentials.
 *
 * Without --source it just rebuilds from data/Dev_Schedule.xlsx as it stands.
 *
 * Steps: copy (optional) -> build -> verify -> commit and push if anything moved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(root, 'data', 'Dev_Schedule.xlsx');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};
/**
 * Where the workbook comes from, in order of preference:
 *   1. --source <path>
 *   2. DEV_TRACKER_XLSX
 *   3. the CRM folder the existing weekly pipeline downloads into, resolved relative to
 *      this repo so no username is baked in: <repo>/../../REPORT/3. CRM
 * In case 3 the most recently modified workbook wins. A "_latest_" copy only breaks a
 * tie — preferring it outright meant a file downloaded by hand today lost to a
 * "_latest_" copy from last week.
 */
function discover() {
  const dir = path.resolve(root, '..', '..', 'REPORT', '3. CRM');
  if (!fs.existsSync(dir)) return null;

  const candidates = fs
    .readdirSync(dir)
    .filter((name) => /dev_schedule.*\.xlsx$/i.test(name) && !name.startsWith('~$'))
    .map((name) => ({
      file: path.join(dir, name),
      latest: name.toLowerCase().startsWith('_latest_'),
      mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime || Number(b.latest) - Number(a.latest));

  return candidates[0]?.file ?? null;
}

const source = flag('--source') ?? process.env.DEV_TRACKER_XLSX ?? discover();
const push = !args.includes('--no-push');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 1. copy */
if (source) {
  if (!fs.existsSync(source)) fail(`Source workbook not found: ${source}`);

  const incoming = fs.readFileSync(source);
  if (incoming.length < 1024) fail(`Source is only ${incoming.length} bytes — refusing to overwrite.`);
  if (incoming[0] !== 0x50 || incoming[1] !== 0x4b) fail('Source is not an .xlsx file (a workbook is a zip).');

  const same = fs.existsSync(TARGET) && fs.readFileSync(TARGET).equals(incoming);
  fs.writeFileSync(TARGET, incoming);
  console.log(`  source:   ${source}`);
  console.log(`  workbook: ${same ? 'identical to the current one' : 'updated'}`);
} else {
  console.log('  source:   data/Dev_Schedule.xlsx (no --source given)');
}

/* ---------------------------------------------------------------- 2. build */
const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail('Build failed — the board was not updated.');

/* ---------------------------------------------------------------- 3. verify */
const tracker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tracker.json'), 'utf8'));
if (!Array.isArray(tracker.rows) || tracker.rows.length === 0) {
  fail('The sheet parsed to 0 rows — check the sheet name, header row and column names.');
}

/* ---------------------------------------------------------------- 4. publish */
let inRepo = true;
try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  inRepo = false;
}

if (!inRepo) {
  console.log('\n  Not a git repository — built locally, nothing published.\n');
  process.exit(0);
}

const dirty = git('status', '--porcelain');
if (!dirty) {
  console.log('\n  Nothing changed this week. Nothing to publish.\n');
  process.exit(0);
}

if (!push) {
  console.log(`\n  Changes ready but --no-push was set:\n${dirty}\n`);
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
git('add', '-A');
git('commit', '-m', `Weekly refresh (${stamp})`);
git('push');

console.log(`\n  Published. ${tracker.rows.length} rows.`);
console.log('  GitHub Pages redeploys in a minute or two.\n');
