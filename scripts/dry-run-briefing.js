// Read-only morning/reminder/escalation preview.
// Never calls Telegram. Uses AIRTABLE_TOKEN when it is already in the
// environment; otherwise reads through the dashboard proxy's atGet action
// (the same read the dashboard already makes) and blocks every other call.
const fs = require('fs');
const path = require('path');

function proxySecret() {
  if (process.env.WEBAPP_SECRET) return process.env.WEBAPP_SECRET;
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/WEBAPP_SECRET\s*=\s*'([^']+)'/);
  if (!m) throw new Error('WEBAPP_SECRET not found');
  return m[1];
}

function installReadOnlyTransport() {
  const secret = proxySecret();
  const proxy = 'https://dpew.vercel.app/api/proxy';
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      throw new Error('dry run blocked a Telegram send');
    }
    if (u.includes('api.airtable.com') && opts.method && opts.method !== 'GET') {
      throw new Error('dry run blocked an Airtable write');
    }
    if (!u.includes('api.airtable.com')) return orig(url, opts);

    const parsed = new URL(u);
    const tableId = decodeURIComponent(parsed.pathname.split('/').pop());
    const formula = parsed.searchParams.get('filterByFormula') || undefined;
    const fields = parsed.searchParams.getAll('fields[]');
    const res = await orig(proxy, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        action: 'atGet',
        tableId,
        formula,
        fields: fields.length ? fields : undefined,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      return new Response(JSON.stringify({ error: { message: data.error || 'proxy atGet failed' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ records: data.records || [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function main() {
  if (!process.env.AIRTABLE_TOKEN) {
    process.env.AIRTABLE_TOKEN = 'dry-run';
    installReadOnlyTransport();
  }
  const { previewBoards } = require('../lib/dpew');
  const out = await previewBoards();
  console.log('COUNTS ' + JSON.stringify(out.counts));
  console.log('CARRIED ' + JSON.stringify(out.carried));
  console.log('\n===== MORNING BRIEFING (not sent) =====\n');
  console.log(out.morning);
  console.log('\n===== REMINDER (not sent) =====\n');
  console.log(out.reminder);
  console.log('\n===== ESCALATION TO HARI (not sent) =====\n');
  console.log(out.escalationHari);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
