/**
 * Loads pricing and rules at runtime.
 *
 * Order of preference:
 *   1. The published Google Sheet (live - the owner edits it and it goes live
 *      on the next page load)
 *   2. sessionStorage, if the sheet was already fetched this session
 *   3. The committed /data/*.csv snapshots, with a visible notice
 *
 * `?refresh=1` bypasses the session cache. That is how the owner verifies a
 * price change actually went live.
 *
 * Nothing in here knows anything about pricing maths. It returns data.
 */

const CACHE_KEY = 'srr-gutter-config-v1';
const FETCH_TIMEOUT_MS = 12000;

/**
 * Columns that must never reach the browser, the DOM, or a public URL.
 * Stripped at parse time so there is no path by which they can leak, even if
 * someone publishes the whole sheet by accident.
 */
const INTERNAL_PRICING_COLUMNS = ['Unit Cost', 'UnitCost', 'Cost', 'Margin'];
const INTERNAL_RULE_KEYS = ['target_margin'];

/** Rules whose values are numbers. Everything else stays a string. */
const NUMERIC_RULES = [
  'waste_factor', 'downspout_ft_per_story', 'max_gutter_lf_per_downspout',
  'min_downspouts', 'elbows_per_downspout', 'straps_per_downspout_story',
  'hangers_per_lf', 'end_caps_per_run', 'splash_blocks_per_downspout',
  'sealant_units_per_job', 'minimum_job_price', 'price_rounding',
  'estimate_validity_days', 'estimate_range_pct',
  'gutter_factor_gable', 'gutter_factor_hip', 'gutter_factor_flat',
  'gutter_factor_unknown', 'overhang_allowance_ft', 'footprint_shape_factor',
];

/** Rules the estimator cannot run without. */
const REQUIRED_RULES = [
  'waste_factor', 'downspout_ft_per_story', 'max_gutter_lf_per_downspout',
  'min_downspouts', 'minimum_job_price', 'price_rounding',
  'estimate_range_pct', 'default_gutter_profile',
  'downspout_default_aluminum', 'downspout_default_copper',
  'downspout_roundprofile_aluminum', 'downspout_roundprofile_copper',
];

function sheetUrl(sheetId, tab) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq` +
         `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse CSV. Values contain commas and inch marks (`Gutter - K Style 5"`), so
 * this has to be a real parser. PapaParse if it loaded, otherwise a small
 * RFC4180 reader so the module still works under Node in the tests.
 */
export function parseCsv(text) {
  if (typeof Papa !== 'undefined') {
    const out = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    return out.data;
  }
  return parseCsvFallback(text);
}

/** Minimal RFC4180 parser: quoted fields, embedded commas, doubled quotes. */
export function parseCsvFallback(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      return obj;
    });
}

function isTrue(v) {
  return ['TRUE', 'true', '1', 'YES', 'yes', 'Y'].includes(String(v ?? '').trim());
}

/** Shape raw Pricing rows into the objects the estimator consumes. */
export function normalizePricing(rawRows) {
  return rawRows
    .map((raw) => {
      const row = { ...raw };
      for (const col of INTERNAL_PRICING_COLUMNS) delete row[col];

      // parseRuleNumber returns NaN for an empty cell, where Number('') would
      // return 0. A blank Price means "not priced yet", not "free".
      const price = parseRuleNumber(row.Price);
      return {
        code: String(row.Code ?? '').trim(),
        name: String(row.Name ?? '').trim(),
        description: String(row.Description ?? '').trim(),
        material: String(row.Material ?? '').trim(),
        category: String(row.Category ?? '').trim(),
        profile: String(row.Profile ?? '').trim(),
        uom: String(row.UOM ?? '').trim().toUpperCase(),
        price: Number.isFinite(price) ? price : NaN,
        active: isTrue(row.Active),
        costOfSaleAccount: String(row.CostOfSaleAccount ?? '').trim(),
        isPlaceholder: String(row.Code ?? '').trim().startsWith('TBD-'),
      };
    })
    .filter((r) => r.code !== '' && !isEmptyMirrorRow(r));
}

/**
 * A mirror tab formula like `=Pricing!A41` pointed at an empty source row does
 * not return blank - Sheets returns 0, so the published CSV gets rows reading
 * "0,0,0,...". That is what lets the mirrors be dragged well past the current
 * data so new pricing rows appear automatically, without the padding turning
 * into junk SKUs. A real code is never literally "0".
 */
function isEmptyMirrorRow(row) {
  return row.code === '0' && (row.name === '' || row.name === '0');
}

/**
 * Read a number the way a spreadsheet might have written it.
 *
 * A cell formatted as a percentage publishes as "10%", not 0.1, and plain
 * Number("10%") is NaN - which took down the whole config the first time the
 * live sheet was connected. Currency symbols and thousands separators get the
 * same treatment. A bare 0.1 still means 0.1; only a trailing % rescales.
 */
export function parseRuleNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;

  const isPercent = raw.endsWith('%');
  const cleaned = raw.replace(/[%$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return isPercent ? n / 100 : n;
}

/** Shape raw Rules rows into a plain key/value object. */
export function normalizeRules(rawRows) {
  const rules = {};
  const notes = {};
  for (const raw of rawRows) {
    const key = String(raw.Key ?? '').trim();
    // '0' is the padding a mirror formula emits for an empty source row.
    if (!key || key === '0' || INTERNAL_RULE_KEYS.includes(key)) continue;
    const value = String(raw.Value ?? '').trim();
    rules[key] = NUMERIC_RULES.includes(key) ? parseRuleNumber(value) : value;
    notes[key] = String(raw.Notes ?? '').trim();
  }
  return { rules, notes };
}

/**
 * Check the config is safe to quote from. Returns { errors, warnings }.
 * An error means refuse to quote. A warning means quote but say something.
 */
export function validateConfig(pricing, rules) {
  const errors = [];
  const warnings = [];

  if (!pricing.length) {
    errors.push('Pricing sheet is empty.');
    return { errors, warnings };
  }

  // normalizePricing has already mapped the sheet header onto these names, so
  // a missing one means the sheet header itself changed.
  for (const k of ['code', 'name', 'material', 'category', 'uom', 'price', 'active']) {
    if (!(k in pricing[0])) errors.push(`Pricing rows are missing "${k}".`);
  }

  const badPrice = pricing.filter((r) => r.active && !Number.isFinite(r.price));
  if (badPrice.length) {
    errors.push(
      `Price is not a number on ${badPrice.length} active row(s): ` +
      badPrice.slice(0, 3).map((r) => r.code).join(', ')
    );
  }

  const activeGutters = pricing.filter((r) => r.active && r.category === 'Gutter');
  for (const material of ['Aluminum', 'Copper']) {
    if (!activeGutters.some((r) => r.material === material)) {
      errors.push(`No active Gutter row for ${material}.`);
    }
  }

  for (const key of REQUIRED_RULES) {
    if (rules[key] === undefined || rules[key] === '') {
      errors.push(`Rules tab is missing "${key}".`);
    } else if (NUMERIC_RULES.includes(key) && !Number.isFinite(rules[key])) {
      errors.push(`Rule "${key}" is not a number.`);
    }
  }

  // Geo rules are only needed once address lookup is wired up, so these are
  // warnings rather than errors.
  for (const key of ['gutter_factor_gable', 'gutter_factor_hip',
                     'gutter_factor_flat', 'gutter_factor_unknown',
                     'overhang_allowance_ft', 'footprint_shape_factor']) {
    if (!Number.isFinite(rules[key])) {
      warnings.push(`Rule "${key}" is missing from the sheet; using a built-in default.`);
    }
  }

  const placeholders = pricing.filter((r) => r.isPlaceholder && !r.active);
  if (placeholders.length) {
    warnings.push(
      `${placeholders.length} parts are still placeholders (Code starts with TBD-). ` +
      'They are listed on the estimate as unpriced.'
    );
  }

  if (String(rules.company_phone ?? '').trim().toUpperCase() === 'TBD') {
    warnings.push('company_phone is still TBD on the Rules tab.');
  }
  if (String(rules.company_license ?? '').trim().toUpperCase() === 'TBD') {
    warnings.push('company_license is still TBD on the Rules tab.');
  }

  return { errors, warnings };
}

async function loadFromSheet(sheetId, tabs) {
  const [pricingCsv, rulesCsv] = await Promise.all([
    fetchText(sheetUrl(sheetId, tabs.pricing)),
    fetchText(sheetUrl(sheetId, tabs.rules)),
  ]);
  return { pricingCsv, rulesCsv };
}

/**
 * Published-CSV route. Google's "Publish to web" gives a per-tab CSV URL that
 * works while the document itself stays private, which is the only way to feed
 * the site without putting `Unit Cost` on a link-shared document. Preferred
 * over the gviz route; see README "Connecting the sheet".
 */
async function loadFromPublished(pricingUrl, rulesUrl) {
  const [pricingCsv, rulesCsv] = await Promise.all([
    fetchText(pricingUrl),
    fetchText(rulesUrl),
  ]);
  return { pricingCsv, rulesCsv };
}

async function loadFromSnapshot(basePath) {
  const [pricingCsv, rulesCsv] = await Promise.all([
    fetchText(`${basePath}data/pricing.csv`),
    fetchText(`${basePath}data/rules.csv`),
  ]);
  return { pricingCsv, rulesCsv };
}

/**
 * Build the config object from two CSV strings. Pure - no network, no storage.
 * Exported so tests can drive it with fixtures.
 */
export function buildConfig(pricingCsv, rulesCsv, source) {
  const pricing = normalizePricing(parseCsv(pricingCsv));
  const { rules, notes } = normalizeRules(parseCsv(rulesCsv));
  const { errors, warnings } = validateConfig(pricing, rules);
  return { pricing, rules, ruleNotes: notes, source, errors, warnings };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.sheetId]     Google Sheet id, or '' for snapshot only
 * @param {string} [opts.pricingUrl]  published-CSV URL; takes priority over sheetId
 * @param {string} [opts.rulesUrl]    published-CSV URL; takes priority over sheetId
 * @param {object} [opts.tabs]        gviz tab names, default the Web_* mirrors
 * @param {boolean} [opts.refresh]    bypass the session cache
 * @param {string} [opts.basePath]    where /data lives relative to the page
 */
export async function loadConfig(opts = {}) {
  const {
    sheetId = '',
    pricingUrl = '',
    rulesUrl = '',
    // Default to the margin-free mirror tabs, never the raw ones. Reading
    // `Pricing` directly would pull `Unit Cost` across the wire.
    tabs = { pricing: 'Web_Pricing', rules: 'Web_Rules' },
    refresh = false,
    basePath = './',
  } = opts;

  if (!refresh) {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { pricingCsv, rulesCsv, source } = JSON.parse(cached);
        return buildConfig(pricingCsv, rulesCsv, source);
      }
    } catch { /* private mode, or corrupt cache - just refetch */ }
  }

  let csvs = null;
  let source = 'snapshot';
  let fetchError = null;

  if (pricingUrl && rulesUrl) {
    try {
      csvs = await loadFromPublished(pricingUrl, rulesUrl);
      source = 'sheet';
    } catch (err) {
      fetchError = err;
    }
  } else if (sheetId) {
    try {
      csvs = await loadFromSheet(sheetId, tabs);
      source = 'sheet';
    } catch (err) {
      fetchError = err;
    }
  }

  if (!csvs) {
    csvs = await loadFromSnapshot(basePath);
    source = 'snapshot';
  }

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...csvs, source }));
  } catch { /* storage full or unavailable - not fatal */ }

  const config = buildConfig(csvs.pricingCsv, csvs.rulesCsv, source);

  if (source === 'snapshot') {
    const configured = Boolean(sheetId || (pricingUrl && rulesUrl));
    config.warnings.unshift(
      configured
        ? `Could not reach the live pricing sheet${fetchError ? ` (${fetchError.message})` : ''}. ` +
          'Showing the last saved snapshot, which may be out of date. ' +
          'If the sheet is new, check it has been published or shared - see README.'
        : 'No sheet configured. Showing the committed pricing snapshot.'
    );
  }

  return config;
}

export const __internals = {
  CACHE_KEY, REQUIRED_RULES, NUMERIC_RULES,
  INTERNAL_PRICING_COLUMNS, INTERNAL_RULE_KEYS, sheetUrl,
};
