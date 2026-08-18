/**
 * Downloads the Dev Tracker workbook from SharePoint / OneDrive for Business.
 *
 * Runs unattended in GitHub Actions every Saturday morning. Uses Microsoft Graph with
 * an Azure AD app registration (client credentials), so it needs no signed-in user.
 *
 * Required environment / repository secrets:
 *   SP_TENANT_ID      Azure AD directory (tenant) ID
 *   SP_CLIENT_ID      Application (client) ID of the registered app
 *   SP_CLIENT_SECRET  Client secret value
 *   SP_SHARE_URL      The SharePoint sharing link to the workbook
 *
 * The app registration needs the APPLICATION permission Files.Read.All with admin
 * consent. Read-only on purpose: this never writes back to SharePoint.
 *
 * Run: npm run fetch:sharepoint
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(root, 'data', 'Dev_Schedule.xlsx');

const { SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SHARE_URL } = process.env;

const missing = ['SP_TENANT_ID', 'SP_CLIENT_ID', 'SP_CLIENT_SECRET', 'SP_SHARE_URL'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing: ${missing.join(', ')}`);
  console.error('See the "SharePoint 자동 갱신" section of README.md for the one-time setup.\n');
  process.exit(1);
}

/** Graph addresses a sharing link as u! + unpadded base64url of the URL. */
function shareToken(url) {
  return `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: SP_CLIENT_ID,
    client_secret: SP_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(`https://login.microsoftonline.com/${SP_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${json.error_description ?? JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function main() {
  const token = await getToken();
  const headers = { authorization: `Bearer ${token}` };
  const share = shareToken(SP_SHARE_URL);

  // Metadata first: it names the file and tells us when it last changed, which is worth
  // logging so a failed weekly run is diagnosable from the Actions log alone.
  const metaRes = await fetch(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem`, { headers });
  if (!metaRes.ok) {
    const detail = await metaRes.text();
    throw new Error(
      `Could not resolve the sharing link (${metaRes.status}). ` +
        `Check SP_SHARE_URL and that the app has Files.Read.All with admin consent.\n${detail.slice(0, 400)}`,
    );
  }
  const meta = await metaRes.json();
  console.log(`  file:      ${meta.name}`);
  console.log(`  modified:  ${meta.lastModifiedDateTime} by ${meta.lastModifiedBy?.user?.displayName ?? 'unknown'}`);
  console.log(`  size:      ${(meta.size / 1024).toFixed(0)} kB`);

  const contentRes = await fetch(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem/content`, { headers });
  if (!contentRes.ok) throw new Error(`Download failed (${contentRes.status})`);

  const buffer = Buffer.from(await contentRes.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`Downloaded file is only ${buffer.length} bytes — refusing to overwrite.`);

  // A workbook is a zip; anything else means we were handed a login page.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Downloaded content is not an .xlsx file — the link probably returned an HTML page.');
  }

  const changed = !fs.existsSync(TARGET) || !fs.readFileSync(TARGET).equals(buffer);
  fs.writeFileSync(TARGET, buffer);

  console.log(changed ? '\n  workbook updated.\n' : '\n  workbook is unchanged since the last run.\n');
  // Surfaced to the workflow so it can skip an empty commit.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

main().catch((error) => {
  console.error(`\nSharePoint fetch failed: ${error.message}\n`);
  process.exit(1);
});
