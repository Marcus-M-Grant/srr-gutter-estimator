/**
 * The pricing engine.
 *
 * PURE. It takes a config object and an inputs object and returns a result
 * object. No fetch, no DOM, no Date, no randomness. That is what makes the
 * numbers auditable and the tests meaningful - if a customer disputes a
 * figure, every intermediate value is in the result.
 *
 * It reads `Price` and nothing else. `Unit Cost` and `target_margin` never
 * reach this module (config.js strips them), so changing the margin in the
 * sheet moves `Price` and the engine simply follows.
 */

/** Round to cents without the usual float drift. */
export function roundCents(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Ceil with a tolerance, so 232.00000000000003 does not become 233. */
function ceilSafe(n) {
  return Math.ceil(n - 1e-9);
}

/** '5' from 'K Style 5"', '6' from 'Half Round 6"'. null if there is no size. */
export function profileSize(profile) {
  const m = String(profile ?? '').match(/(\d+(?:\.\d+)?)\s*"/);
  return m ? Number(m[1]) : null;
}

const active = (rows) => rows.filter((r) => r.active);

/** Distinct materials that have at least one active gutter row. */
export function availableMaterials(pricing) {
  return [...new Set(active(pricing)
    .filter((r) => r.category === 'Gutter')
    .map((r) => r.material))].sort();
}

/** Distinct profiles available for a material, in sheet order. */
export function availableProfiles(pricing, material) {
  return [...new Set(active(pricing)
    .filter((r) => r.category === 'Gutter' && r.material === material && r.profile)
    .map((r) => r.profile))];
}

/**
 * Gutter guards are auto-matched to the gutter size: a 5" gutter pulls the 5"
 * cover, a 6" gutter the 6" cover. Prefer a guard in the same material, but
 * fall back to any active guard of the right size - there is no copper cover
 * in the sheet, and a copper job still gets guards.
 */
export function findGuard(pricing, material, profile) {
  const size = profileSize(profile);
  const guards = active(pricing).filter((r) => r.category === 'Gutter Guard');
  const sized = size === null
    ? guards
    : guards.filter((r) => profileSize(r.name) === size || profileSize(r.code) === size);
  return sized.find((r) => r.material === material) ?? sized[0] ?? null;
}

/** Are guards offerable at all for this gutter? Drives the yes/no in the UI. */
export function guardsAvailable(pricing, material, profile) {
  return findGuard(pricing, material, profile) !== null;
}

/** Look a row up by its exact Code, active or not. */
function byCode(pricing, code) {
  if (!code) return null;
  const want = String(code).trim();
  return pricing.find((r) => r.code === want) ?? null;
}

/**
 * Accessories are paired by their `Description` family. Aluminium and copper
 * versions of the same part share that value; Universal parts (splash blocks,
 * sealant, tear off) have no material twin.
 */
function byFamily(pricing, family, material) {
  const fam = pricing.filter((r) => r.description === family);
  return fam.find((r) => r.material === material)
      ?? fam.find((r) => r.material === 'Universal')
      ?? null;
}

const DOWNSPOUT_RULE = {
  Aluminum: { round: 'downspout_roundprofile_aluminum', default: 'downspout_default_aluminum' },
  Copper: { round: 'downspout_roundprofile_copper', default: 'downspout_default_copper' },
};

/** Accessory families, in the order they appear on the estimate. */
const ACCESSORIES = [
  { key: 'elbowQty', family: 'Gutter - Elbow', label: 'Elbows' },
  { key: 'miterQty', family: 'Gutter - Miter', label: 'Miters / corners' },
  { key: 'endCapQty', family: 'Gutter - End Cap', label: 'End caps' },
  { key: 'hangerQty', family: 'Gutter - Hanger', label: 'Hidden hangers' },
  { key: 'strapQty', family: 'Gutter - Downspout Strap', label: 'Downspout straps' },
  { key: 'splashBlockQty', family: 'Gutter - Splash Block', label: 'Splash blocks' },
  { key: 'sealantQty', family: 'Gutter - Sealant', label: 'Sealant and consumables' },
];

/**
 * @param {object} config  { pricing, rules } from config.js
 * @param {object} inputs
 * @param {number} inputs.measuredLF   gutter linear feet (already roof-factored)
 * @param {string} [inputs.lfSource]   'osm' | 'sqft' | 'manual'
 * @param {number} [inputs.stories]    1-3
 * @param {string} inputs.material     'Aluminum' | 'Copper'
 * @param {string} inputs.profile      e.g. 'K Style 5"'
 * @param {boolean} [inputs.guards]
 * @param {number} [inputs.runs]       separate gutter runs, for end caps
 * @param {number} [inputs.corners]    for miters
 */
export function estimate(config, inputs) {
  const { pricing, rules } = config;
  const {
    measuredLF,
    lfSource = 'manual',
    stories = 1,
    material,
    profile,
    guards = false,
    runs = 1,
    corners = 4,
    // Optional provenance from the measurement chain. Recorded in the
    // assumptions and on the statement of work; they never affect a price.
    perimeterFt = null,
    roofType = null,
    roofFactor = null,
  } = inputs;

  if (!Number.isFinite(measuredLF) || measuredLF <= 0) {
    throw new Error('measuredLF must be a positive number.');
  }
  if (!material || !profile) {
    throw new Error('material and profile are required.');
  }

  // ---- quantities, in the order the spec defines them --------------------
  const wasteFactor = rules.waste_factor;
  const billableLF = ceilSafe(measuredLF * (1 + wasteFactor));

  const downspoutCount = Math.max(
    rules.min_downspouts,
    ceilSafe(measuredLF / rules.max_gutter_lf_per_downspout)
  );
  const downspoutLF = downspoutCount * stories * rules.downspout_ft_per_story;

  const qty = {
    billableLF,
    downspoutCount,
    downspoutLF,
    elbowQty: downspoutCount * rules.elbows_per_downspout,
    strapQty: downspoutCount * stories * rules.straps_per_downspout_story,
    hangerQty: ceilSafe(billableLF * rules.hangers_per_lf),
    endCapQty: runs * rules.end_caps_per_run,
    miterQty: corners,
    splashBlockQty: downspoutCount * rules.splash_blocks_per_downspout,
    sealantQty: rules.sealant_units_per_job,
    guardLF: guards ? billableLF : 0,
    tearOffLF: billableLF,
  };

  // ---- resolve SKUs and build lines --------------------------------------
  const lines = [];
  const unpriced = [];

  /**
   * Add one line. A row that is missing, inactive, or has no usable price is
   * recorded as unpriced rather than substituted - guessing a replacement SKU
   * would put the wrong part on a real work order.
   */
  const addLine = (row, quantity, label, notFoundCode) => {
    if (quantity <= 0) return;

    if (!row) {
      unpriced.push({
        code: notFoundCode ?? '(none)', name: label, qty: quantity,
        uom: '', reason: 'no matching item in the pricing sheet',
      });
      return;
    }
    if (!row.active || !Number.isFinite(row.price)) {
      unpriced.push({
        code: row.code, name: row.name, qty: quantity, uom: row.uom,
        reason: row.isPlaceholder
          ? 'placeholder part, not yet priced'
          : 'item is switched off in the pricing sheet',
      });
      return;
    }
    lines.push({
      code: row.code,
      name: row.name,
      qty: quantity,
      uom: row.uom,
      unitPrice: row.price,
      lineTotal: roundCents(quantity * row.price),
      costOfSaleAccount: row.costOfSaleAccount,
    });
  };

  // Gutter
  const gutterRow = active(pricing).find(
    (r) => r.category === 'Gutter' && r.material === material && r.profile === profile
  ) ?? pricing.find(
    (r) => r.category === 'Gutter' && r.material === material && r.profile === profile
  );
  addLine(gutterRow, billableLF, `Gutter - ${material} ${profile}`);

  // Downspout: the round code for Half Round gutters, the rectangular one
  // otherwise. Both come from the Rules tab, never from a hardcoded string.
  const dsRules = DOWNSPOUT_RULE[material];
  const isRound = /half\s*round/i.test(profile);
  const downspoutCode = dsRules
    ? rules[isRound ? dsRules.round : dsRules.default]
    : null;
  const downspoutRow = byCode(pricing, downspoutCode);
  addLine(downspoutRow, downspoutLF, `Downspout - ${material}`, downspoutCode);

  // Gutter guards, size-matched to the gutter
  if (guards && qty.guardLF > 0) {
    addLine(findGuard(pricing, material, profile), qty.guardLF, 'Gutter guards');
  }

  // Accessories
  for (const acc of ACCESSORIES) {
    addLine(byFamily(pricing, acc.family, material), qty[acc.key], acc.label);
  }

  // Tear off and haul away
  addLine(byFamily(pricing, 'Gutter - Tear Off', material), qty.tearOffLF,
          'Tear off and haul away');

  // ---- totals -------------------------------------------------------------
  const subtotal = roundCents(lines.reduce((s, l) => s + l.lineTotal, 0));
  const minimumApplied = subtotal < rules.minimum_job_price;
  const afterMinimum = Math.max(subtotal, rules.minimum_job_price);

  const rounding = rules.price_rounding;
  const total = rounding > 0
    ? ceilSafe(afterMinimum / rounding) * rounding
    : roundCents(afterMinimum);

  const band = rules.estimate_range_pct;
  const lowBand = roundCents(total * (1 - band));
  const highBand = roundCents(total * (1 + band));

  return {
    inputs: { measuredLF, lfSource, stories, material, profile, guards, runs, corners },
    quantities: qty,
    lines,
    unpriced,
    subtotal,
    minimumApplied,
    total,
    lowBand,
    highBand,
    assumptions: {
      lfSource,
      perimeterFt: Number.isFinite(perimeterFt) ? perimeterFt : undefined,
      roofType: roofType ?? undefined,
      roofFactor: Number.isFinite(roofFactor) ? roofFactor : undefined,
      wasteFactor,
      billableLF,
      stories,
      downspoutRule: `1 downspout per ${rules.max_gutter_lf_per_downspout} LF, minimum ${rules.min_downspouts}`,
      downspoutFtPerStory: rules.downspout_ft_per_story,
      corners,
      runs,
      minimumJobPrice: rules.minimum_job_price,
      priceRounding: rounding,
      estimateRangePct: band,
      validityDays: rules.estimate_validity_days,
    },
  };
}
