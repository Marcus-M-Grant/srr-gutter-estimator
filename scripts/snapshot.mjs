/**
 * Pull the live Google Sheet into /data/*.csv so the offline fallback stays
 * fresh. Runs locally, never on Pages.
 *
 *   npm run snapshot
 *
 * Reads PRICING_CSV_URL and RULES_CSV_URL from ./config.js (the published-CSV
 * route), falling back to the gviz route via SHEET_ID for a shared document.
 *
 * Drops the `Unit Cost` column and the `target_margin` rule before writing.
 * /data is served publicly by GitHub Pages; SRR's cost basis does not go there.
 */

import { writeFile } from 'node:fs/promises';
// Reuse the runtime's own number parsing so the snapshot and the live path
// agree on what "$21.82" and "10%" mean.
import { parseRuleNumber, __internals } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const INTERNAL_COLUMNS = ['Unit Cost', 'UnitCost', 'Cost', 'Margin'];
const INTERNAL_RULES = ['target_margin'];

/**
 * Where to read from, in the same order the site uses.
 *
 * The published-CSV URLs come first because the document itself is private -
 * the gviz route needs read access and just redirects to a Google login, so it
 * cannot work for a private sheet no matter what id it is given.
 */
async function resolveSource() {
  let cfg = {};
  try {
    cfg = await import(new URL('../config.js', import.meta.url));
  } catch { /* no config.js */ }

  const pricingUrl = process.env.PRICING_CSV_URL || cfg.PRICING_CSV_URL || '';
  const rulesUrl = process.env.RULES_CSV_URL || cfg.RULES_CSV_URL || '';
  if (pricingUrl && rulesUrl) return { kind: 'published', pricingUrl, rulesUrl };

  const sheetId = process.argv[2] || process.env.SHEET_ID || cfg.SHEET_ID || '';
  if (sheetId) return { kind: 'gviz', sheetId };
  return { kind: 'none' };
}

function url(sheetId, tab) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq` +
         `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

/** RFC4180 parse into [header[], ...rows[]]. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

async function fetchCsv(target, label) {
  const res = await fetch(target, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      `${label}: got HTML instead of CSV. Either the tab is not published to ` +
      'the web, or the document is private and this is the gviz route (which ' +
      'redirects to a Google login). See README "Connecting the sheet".'
    );
  }
  return parseCsv(text);
}

function stripColumns(rows, names) {
  const header = rows[0].map((h) => h.trim());
  const drop = new Set(
    names.map((n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase()))
         .filter((i) => i >= 0)
  );
  if (!drop.size) return rows;
  return rows.map((r) => r.filter((_, i) => !drop.has(i)));
}

/**
 * The Web_* mirror tabs carry "PUBLISH THIS TAB" instructions off to the right,
 * so the published CSV has unnamed trailing columns. Keep only the columns the
 * header actually names.
 */
function dropNotesColumns(rows) {
  const width = rows[0].findIndex((h) => String(h).trim() === '');
  if (width <= 0) return rows;
  return rows.map((r) => r.slice(0, width)).filter((r) => r.some((c) => String(c).trim()));
}

function stripRules(rows, keys) {
  const lowered = keys.map((k) => k.toLowerCase());
  return rows.filter((r, i) => i === 0 || !lowered.includes(String(r[0]).trim().toLowerCase()));
}

/** Everything after the first blank Code is legend text, not data. */
function truncateAtBlankCode(rows) {
  const out = [rows[0]];
  for (const r of rows.slice(1)) {
    if (!String(r[0] ?? '').trim()) break;
    out.push(r);
  }
  return out;
}

async function main() {
  const source = await resolveSource();
  if (source.kind === 'none') {
    console.error(
      'Nothing to read from. Set PRICING_CSV_URL and RULES_CSV_URL in config.js\n' +
      '(File > Share > Publish to web on the Web_Pricing and Web_Rules tabs),\n' +
      'or reseed from the local workbook instead:\n' +
      '  python scripts/seed-from-xlsx.py'
    );
    process.exit(1);
  }

  let pricing;
  let rules;
  if (source.kind === 'published') {
    console.log('Reading the published Web_Pricing and Web_Rules CSVs.');
    pricing = await fetchCsv(source.pricingUrl, 'Web_Pricing');
    rules = await fetchCsv(source.rulesUrl, 'Web_Rules');
  } else {
    console.log('No published URLs set; trying gviz (needs a shared document).');
    pricing = await fetchCsv(url(source.sheetId, 'Web_Pricing'), 'Web_Pricing');
    rules = await fetchCsv(url(source.sheetId, 'Web_Rules'), 'Web_Rules');
  }

  pricing = dropNotesColumns(stripColumns(truncateAtBlankCode(pricing), INTERNAL_COLUMNS));
  rules = dropNotesColumns(stripRules(rules, INTERNAL_RULES));

  // Sheets publishes formatted cells the way they LOOK: "$21.82", "10%".
  // Normalize them to plain numbers so the committed snapshot is canonical and
  // matches what seed-from-xlsx.py produces - otherwise the two sources give
  // gratuitously different diffs.
  const priceCol = pricing[0].findIndex((h) => String(h).trim() === 'Price');
  if (priceCol < 0) throw new Error('Pricing tab has no Price column.');

  const bad = [];
  for (const row of pricing.slice(1)) {
    const n = parseRuleNumber(row[priceCol]);
    if (!Number.isFinite(n)) bad.push(row);
    else row[priceCol] = n.toFixed(2);
  }
  if (bad.length) {
    throw new Error(`Price is not a number on ${bad.length} row(s), e.g. "${bad[0][0]}". ` +
                    'Refusing to overwrite the snapshot with a broken sheet.');
  }

  const keyCol = 0;
  const valCol = 1;
  for (const row of rules.slice(1)) {
    const key = String(row[keyCol] ?? '').trim();
    if (!__internals.NUMERIC_RULES.includes(key)) continue;
    const n = parseRuleNumber(row[valCol]);
    if (Number.isFinite(n)) row[valCol] = String(n);
  }

  // The TBD- rows are placeholders for parts nobody has costed yet. They ship
  // with no Price on purpose - publishing an invented figure under SRR's name
  // is worse than publishing none. Shout if one reappears.
  const codeCol = pricing[0].findIndex((h) => String(h).trim() === 'Code');
  const invented = pricing.slice(1).filter((r) =>
    String(r[codeCol] ?? '').startsWith('TBD-') && parseRuleNumber(r[priceCol]) > 0);
  if (invented.length) {
    console.warn([
      '',
      `WARNING: ${invented.length} placeholder row(s) came back with a price, ` +
        `e.g. ${invented[0][codeCol]}.`,
      'Those costs are guesses, not SRR figures. Clear the Unit Cost cell for',
      'each TBD- row in the sheet, or replace it with the real cost.',
      '',
    ].join('\n'));
  }

  await writeFile(join(ROOT, 'data', 'pricing.csv'), toCsv(pricing), 'utf8');
  await writeFile(join(ROOT, 'data', 'rules.csv'), toCsv(rules), 'utf8');

  console.log(`data/pricing.csv  ${pricing.length - 1} rows`);
  console.log(`data/rules.csv    ${rules.length - 1} keys`);
  console.log('Snapshot refreshed. Commit these two files.');
}

main().catch((err) => {
  console.error('Snapshot failed:', err.message);
  process.exit(1);
});
