/**
 * Rendering and form state.
 *
 * PHASES 5 + 6: address lookup, the building outline on a map, the confirm
 * step, and the fully editable chain from spec 6.5 - every step visible, every
 * step overridable, and nothing silently overwritten when something else
 * changes.
 *
 * Every dropdown here is built from the pricing sheet. Nothing is hardcoded.
 */

import {
  estimate, availableMaterials, availableProfiles, guardsAvailable,
} from './estimator.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const money = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money2 = (n) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/**
 * Join the four address fields into the one line the geocoder and the
 * statement of work both want. Skips whatever the customer left blank rather
 * than emitting stray commas.
 */
export function fullAddress(state) {
  const street = String(state.addressLine ?? '').trim();
  const city = String(state.city ?? '').trim();
  const region = String(state.stateCode ?? '').trim().toUpperCase();
  const zip = String(state.zip ?? '').trim();

  const tail = [region, zip].filter(Boolean).join(' ');
  return [street, city, tail].filter(Boolean).join(', ');
}

/** Enough to bother a geocoder with? Street plus either a city or a ZIP. */
export function addressIsUsable(state) {
  const street = String(state.addressLine ?? '').trim();
  const city = String(state.city ?? '').trim();
  const zip = String(state.zip ?? '').trim();
  return Boolean(street) && Boolean(city || zip);
}

/** Nearest-integer display for quantities that are conceptually whole. */
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// form state
// ---------------------------------------------------------------------------

/**
 * Roof type drives the single biggest correction in the whole calculation:
 * gutter hangs on eaves, not rakes, so a gable roof gets gutter on roughly two
 * of four sides and a hip roof on all four. Illustrated, not jargon.
 */
export const ROOF_TYPES = [
  {
    value: 'gable', label: 'Gable',
    hint: 'Two sloped sides, a triangle at each end',
    svg: '<path d="M4 26 L4 16 L20 5 L36 16 L36 26 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M4 16 L20 5 L36 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>',
  },
  {
    value: 'hip', label: 'Hip',
    hint: 'Slopes down on all four sides',
    svg: '<path d="M4 26 L4 17 L20 6 L36 17 L36 26 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M4 17 L13 12 L27 12 L36 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M13 12 L20 6 L27 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>',
  },
  {
    value: 'flat', label: 'Flat',
    hint: 'Flat or barely sloped',
    svg: '<path d="M4 26 L4 12 L36 12 L36 26 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M2 12 L38 12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  },
  {
    value: 'unknown', label: 'Not sure',
    hint: 'We will use a middle-of-the-road figure',
    svg: '<path d="M4 26 L4 16 L20 7 L36 16 L36 26 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-dasharray="4 3"/><text x="20" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">?</text>',
  },
];

export function initialState(config) {
  const materials = availableMaterials(config.pricing);
  const material = materials.includes('Aluminum') ? 'Aluminum' : materials[0];
  const profiles = availableProfiles(config.pricing, material);
  const preferred = config.rules.default_gutter_profile;

  return {
    addressLine: '',
    city: '',
    stateCode: 'CA',
    zip: '',
    // Measurement chain (phases 4 and 6)
    measurement: null,        // a measureAddress result, or null
    lookupStatus: 'idle',     // idle | looking | done | error
    lookupError: '',
    buildingConfirmed: false,
    roofType: 'unknown',
    perimeterOverride: null,  // a perimeter the customer typed
    disabledSides: [],        // wall indices with no gutter
    showSides: false,
    sqFt: null,               // Method B input
    sqFtStories: 1,
    lfOverridden: false,      // the customer typed a figure; stop auto-filling

    measuredLF: null,
    lfSource: 'manual',
    stories: 1,
    material,
    profile: profiles.includes(preferred) ? preferred : profiles[0],
    guards: false,
    runs: 1,
    corners: 4,
  };
}

// ---------------------------------------------------------------------------
// form markup
// ---------------------------------------------------------------------------

function radioGroup(name, options, current) {
  return `<div class="choices">${options.map((o) => `
    <label class="choice">
      <input type="radio" name="${name}" value="${esc(o.value)}"
             ${String(o.value) === String(current) ? 'checked' : ''}>
      <span>${esc(o.label)}</span>
    </label>`).join('')}</div>`;
}

/** Illustrated roof picker. The single biggest lever on the final number. */
function renderRoofPicker(state, chain) {
  const muted = chain && chain.roofFactorApplies === false;
  return `
  <fieldset class="fieldset ${muted ? 'is-muted' : ''}">
    <legend>Roof type <span class="sub">&mdash;
      ${muted
        ? 'superseded by your wall choices above'
        : 'changes how much of the outline gets gutter'}</span></legend>
    <div class="roofs">
      ${ROOF_TYPES.map((r) => `
        <label class="roof">
          <input type="radio" name="roofType" value="${esc(r.value)}"
                 ${state.roofType === r.value ? 'checked' : ''}>
          <span class="roof__box">
            <svg viewBox="0 0 40 30" class="roof__svg" aria-hidden="true">${r.svg}</svg>
            <span class="roof__label">${esc(r.label)}</span>
          </span>
        </label>`).join('')}
    </div>
  </fieldset>`;
}

/**
 * Each wall with its length, so a shared wall, a patio run or a garage side can
 * be switched off. Spec 6.5.
 */
function renderSides(state, m) {
  const sides = m.sides ?? [];
  if (!sides.length) return '';

  const overridden = Number.isFinite(state.perimeterOverride);
  const off = new Set(state.disabledSides);

  if (!state.showSides) {
    return `<p class="hint" style="margin:0 0 14px">
      <button type="button" class="linkish" id="show-sides">
        Some walls have no gutter? Choose wall by wall
      </button>
    </p>`;
  }

  return `
  <div class="sides ${overridden ? 'sides--muted' : ''}">
    <p class="sides__head">
      Which walls get gutter?
      <button type="button" class="linkish" id="hide-sides">hide</button>
    </p>
    ${overridden ? `<p class="hint" style="margin:0 0 8px">
      You have typed a perimeter, so these no longer apply. Clear it to use them.
    </p>` : ''}
    ${sides.map((side) => `
      <label class="side ${off.has(side.index) ? 'is-off' : ''}">
        <input type="checkbox" class="side-toggle" data-side="${side.index}"
               ${off.has(side.index) ? '' : 'checked'} ${overridden ? 'disabled' : ''}>
        <span class="side__name">Wall ${side.index + 1}</span>
        <span class="side__len">${Math.round(side.lengthFt)} ft</span>
      </label>`).join('')}
    ${off.size && !overridden ? `
      <p class="hint" style="margin:8px 0 0">
        ${off.size} wall${off.size > 1 ? 's' : ''} switched off. Because you have
        said exactly which walls get gutter, the roof-type factor no longer
        applies on top &mdash; that would subtract the same thing twice.
      </p>` : ''}
  </div>`;
}

/**
 * Method B, as a UI. For the addresses OpenStreetMap has no outline for -
 * new build, some multifamily parcels, anything the bulk import missed.
 *
 *   footprint = total sq ft / stories
 *   perimeter = 4 * sqrt(footprint) * footprint_shape_factor
 *
 * Labelled a rough estimate, because that is what it is.
 */
function renderSqFtFallback(state) {
  return `
  <div class="fallback">
    <p class="fallback__head">Estimate from the size of the home instead</p>
    <div class="two-up">
      <div class="field">
        <label for="sqFt">Total home square footage</label>
        <input type="number" id="sqFt" inputmode="numeric" min="100" max="40000"
               step="50" placeholder="e.g. 2,400" value="${state.sqFt ?? ''}">
      </div>
      <div class="field">
        <label for="sqFtStories">Stories</label>
        <input type="number" id="sqFtStories" inputmode="numeric" min="1" max="3"
               step="1" value="${state.sqFtStories ?? 1}">
      </div>
    </div>
    <button type="button" class="btn btn--secondary btn--block" id="use-sqft">
      Use this instead
    </button>
    <p class="hint" style="margin:10px 0 0">
      This is a rough estimate from the floor area, not a measurement of your
      building. Every number stays editable.
    </p>
  </div>`;
}

/** The chain from spec 6.5: every step visible, every step overridable. */
function renderChain(state, chain, m) {
  const overridden = Number.isFinite(state.perimeterOverride);
  return `
  <div class="chain">
    <div class="chain__row">
      <span class="chain__label">
        Building perimeter
        ${overridden ? '<span class="tag">your figure</span>' : ''}
      </span>
      <span class="chain__value">
        <input type="number" class="chain__input" id="perimeter-input"
               inputmode="numeric" min="1" max="20000" step="1"
               value="${overridden ? state.perimeterOverride : Math.round(m.perimeterFt)}"
               aria-label="Building perimeter in feet"> ft
        ${overridden ? `<button type="button" class="linkish" id="clear-perimeter">reset</button>` : ''}
      </span>
    </div>
    ${m.sides?.length ? `
    <div class="chain__row">
      <span class="chain__label">Walls with gutter</span>
      <span class="chain__value">${chain.sideCount} of ${m.sides.length}</span>
    </div>` : ''}
    <div class="chain__row">
      <span class="chain__label">
        Roof type
        ${chain.roofFactorApplies ? '' : '<span class="tag">not applied</span>'}
      </span>
      <span class="chain__value">
        ${esc(chain.roofLabel)} &times; ${chain.roofFactor}
      </span>
    </div>
    <div class="chain__row chain__row--total">
      <span class="chain__label">Gutter run</span>
      <span class="chain__value">${Math.round(chain.gutterLF)} ft</span>
    </div>
  </div>`;
}

/**
 * The measurement, and the confirm step that makes it trustworthy.
 *
 * Phase 4 measured the geocoded point landing inside a building polygon zero
 * times out of eight, with most addresses having more than one building in
 * range. The outline is presented as a STARTING POINT to be confirmed, never
 * as a measurement.
 */
export function renderMeasurement(state, chain) {
  if (state.lookupStatus === 'looking') {
    return `<section class="card" id="measurement">
      <span class="card__step">Your building</span>
      <h2>Looking up your building&hellip;</h2>
      <p class="hint" style="margin:0">
        Checking the public building outline for that address.
      </p>
    </section>`;
  }

  if (state.lookupStatus === 'error') {
    return `<section class="card" id="measurement">
      <span class="card__step">Your building</span>
      <h2>We could not find that building</h2>
      <div class="notice"><strong>${esc(state.lookupError)}</strong>
        No problem. Give us the size of the home instead, or just type the
        linear feet below &mdash; an estimator confirms the real footage on site.
      </div>
      ${renderSqFtFallback(state)}
    </section>`;
  }

  const m = state.measurement;
  if (!m?.ok) return '';

  const alts = m.alternatives ?? [];

  return `
  <section class="card" id="measurement">
    <span class="card__step">Your building</span>
    <h2>${m.method === 'sqft' ? 'Estimated from the floor area' : 'Is this your building?'}</h2>
    <p class="hint">
      ${m.method === 'sqft'
        ? `Worked out from ${Math.round(m.footprintSqFt)} sq ft of footprint. This is a
           rough estimate, not a measurement of your building &mdash; adjust anything
           that looks off.`
        : `We pulled an approximate outline of the building at that address. Adjust
           anything that looks off &mdash; a Specialist Roofing estimator confirms exact
           footage on site.`}
    </p>

    ${m.coords ? `
    <div class="map-wrap">
      <div id="map" class="map" role="img"
           aria-label="Satellite view with your building outlined"></div>
      <span class="map-badge map-badge--${m.needsConfirmation ? 'check' : 'ok'}">
        ${esc(m.confidence)}
      </span>
    </div>` : ''}

    ${alts.length ? (m.selection === 'customer-chosen' ? `
      <div class="notice notice--ok" style="margin-top:12px">
        <strong>Using the building you picked.</strong>
        Tap another outline to change it again.
      </div>` : `
      <div class="notice" style="margin-top:12px">
        <strong>${alts.length + 1} buildings sit close to this address.</strong>
        The address pin landed about ${Math.round(m.chosenDistanceFt)} ft from the
        one we highlighted. Tap a different outline on the map if we picked wrong.
      </div>`) : ''}

    ${renderChain(state, chain, m)}

    ${renderSides(state, m)}

    ${renderRoofPicker(state, chain)}

    <div class="actions" style="margin-top:4px">
      <button type="button" class="btn btn--primary" id="use-measurement">
        ${state.buildingConfirmed ? 'Footage applied' : 'Yes, use this footage'}
      </button>
      <button type="button" class="btn btn--ghost" id="reject-measurement">
        Not my building
      </button>
    </div>
    ${state.sqFtOpen ? renderSqFtFallback(state) : ''}
    <p class="hint" style="margin:10px 0 0">
      This is a starting point from public map data, not a survey.
      ${m.searchRadiusM > 30 ? 'The building sits well back from the road, so we widened the search. ' : ''}
      You can edit the linear feet below at any time.
    </p>
  </section>`;
}

export function renderForm(config, state) {
  const materials = availableMaterials(config.pricing);
  const profiles = availableProfiles(config.pricing, state.material);
  const canGuard = guardsAvailable(config.pricing, state.material, state.profile);

  return `
  <form id="estimate-form" class="card" novalidate>
    <span class="card__step">Your gutters</span>
    <h2>Tell us about the job</h2>
    <p class="hint">
      Start with your address and we will measure the building for you, or skip
      it and type the linear feet yourself. Either way, every number stays
      editable.
    </p>

    <div class="field">
      <label for="addressLine">
        Street address
        <span class="sub">&mdash; we will look up your building outline</span>
      </label>
      <input type="text" id="addressLine" name="addressLine"
             autocomplete="address-line1" placeholder="5031 Fair Avenue"
             value="${esc(state.addressLine ?? '')}">
    </div>

    <div class="addr-grid">
      <div class="field">
        <label for="city">City</label>
        <input type="text" id="city" name="city" autocomplete="address-level2"
               placeholder="North Hollywood" value="${esc(state.city ?? '')}">
      </div>
      <div class="field">
        <label for="stateCode">State</label>
        <input type="text" id="stateCode" name="stateCode" autocomplete="address-level1"
               maxlength="2" placeholder="CA" value="${esc(state.stateCode ?? '')}">
      </div>
      <div class="field">
        <label for="zip">ZIP</label>
        <input type="text" id="zip" name="zip" autocomplete="postal-code"
               inputmode="numeric" maxlength="10" placeholder="91601"
               value="${esc(state.zip ?? '')}">
      </div>
    </div>

    <div class="field">
      <button type="button" class="btn btn--secondary btn--block" id="lookup-btn"
              ${state.lookupStatus === 'looking' ? 'disabled' : ''}>
        ${state.lookupStatus === 'looking'
          ? 'Looking up your building&hellip;'
          : 'Find my building'}
      </button>
      <p class="hint" style="margin:8px 0 0">
        Optional &mdash; you can type the linear feet below instead.
      </p>
    </div>

    <div class="field">
      <label for="measuredLF">
        Linear feet of gutter
        <span class="sub">&mdash; total run around the eaves</span>
      </label>
      <input type="number" id="measuredLF" name="measuredLF" inputmode="numeric"
             min="1" max="5000" step="1" placeholder="e.g. 200"
             value="${state.measuredLF ?? ''}">
      ${state.lfOverridden && state.measurement?.ok ? `
        <p class="hint" style="margin:6px 0 0">
          Using your figure. <button type="button" class="linkish"
            id="recalc-from-address">Recalculate from the address</button>
        </p>` : ''}
    </div>

    <fieldset class="fieldset">
      <legend>Number of stories</legend>
      ${radioGroup('stories', [
        { value: 1, label: '1 story' },
        { value: 2, label: '2 stories' },
        { value: 3, label: '3 stories' },
      ], state.stories)}
    </fieldset>

    <fieldset class="fieldset">
      <legend>Material</legend>
      ${radioGroup('material', materials.map((m) => ({ value: m, label: m })), state.material)}
    </fieldset>

    <div class="field">
      <label for="profile">Gutter style</label>
      <select id="profile" name="profile">
        ${profiles.map((p) => `<option value="${esc(p)}"
          ${p === state.profile ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
    </div>

    <div class="two-up">
      <div class="field">
        <label for="runs">Separate gutter runs <span class="sub">&mdash; end caps</span></label>
        <input type="number" id="runs" name="runs" inputmode="numeric"
               min="1" max="20" step="1" value="${state.runs}">
      </div>
      <div class="field">
        <label for="corners">Corners <span class="sub">&mdash; miters</span></label>
        <input type="number" id="corners" name="corners" inputmode="numeric"
               min="0" max="40" step="1" value="${state.corners}">
      </div>
    </div>

    ${canGuard ? `
    <div class="field">
      <label class="switch">
        <input type="checkbox" id="guards" name="guards" ${state.guards ? 'checked' : ''}>
        <span class="switch__text">Add gutter guards <span class="sub">(sized to match your gutter)</span></span>
      </label>
    </div>` : ''}
  </form>`;
}

// ---------------------------------------------------------------------------
// result markup
// ---------------------------------------------------------------------------

/**
 * The line-item table. The Code column is deliberately present: it is what
 * turns this from a price into something a rep can raise a work order from.
 */
function renderLineItems(r) {
  if (!r.lines.length) return '';
  return `
  <div class="table-scroll">
    <table class="lines">
      <thead><tr>
        <th>Item</th><th>Code</th><th class="num">Qty</th><th>UOM</th>
        <th class="num">Rate</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>
        ${r.lines.map((l) => `<tr>
          <td>${esc(l.name)}</td>
          <td class="code">${esc(l.code)}</td>
          <td class="num">${num(l.qty)}</td>
          <td>${esc(l.uom)}</td>
          <td class="num">${money2(l.unitPrice)}</td>
          <td class="num strong">${money2(l.lineTotal)}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="5" class="num">Subtotal</td>
        <td class="num strong">${money2(r.subtotal)}</td>
      </tr>
      ${r.minimumApplied ? `<tr>
        <td colspan="5" class="num">Company minimum applied</td>
        <td class="num strong">${money2(r.total)}</td>
      </tr>` : ''}
      <tr class="grand">
        <td colspan="5" class="num">Total</td>
        <td class="num">${money2(r.total)}</td>
      </tr></tfoot>
    </table>
  </div>`;
}


/** True when the page was opened with ?debug, which is for SRR, not customers. */
function isDebug() {
  try {
    return new URLSearchParams(location.search).has('debug');
  } catch { return false; }
}

/**
 * Quantities computed but not priced.
 *
 * HIDDEN FROM CUSTOMERS. It exposed internal TBD- placeholder codes and read
 * as an unfinished price list. It is still rendered under ?debug so SRR can
 * see exactly what the quoted total is leaving out.
 *
 * Note what this means: while any part is unpriced, the total genuinely
 * excludes real work. The fix is pricing those rows in the sheet, not hiding
 * the list - see README "Open items".
 */
function renderUnpriced(r) {
  if (!r.unpriced.length || !isDebug()) return '';
  return `
  <div class="notice" style="margin-top:18px">
    <strong>Visible because of ?debug &mdash;
      ${r.unpriced.length} item(s) computed but not priced</strong>
    These are in the scope and will appear on the work order, but they have no
    price in the sheet, so they are <em>not</em> in the total above.
    <div class="table-scroll" style="margin-top:8px">
      <table class="lines lines--plain">
        <tbody>${r.unpriced.map((u) => `<tr>
          <td>${esc(u.name)}</td>
          <td class="code">${esc(u.code)}</td>
          <td class="num">${num(u.qty)} ${esc(u.uom || 'EA')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

/**
 * What the price assumes. This is the only place the waste factor, the
 * downspout rule and the footage provenance are shown, now that the separate
 * quantities card is gone.
 */
function renderAssumptions(r) {
  const a = r.assumptions;
  const i = r.inputs;
  const sourceLabel = {
    osm: 'measured from the building outline',
    sqft: 'estimated from the home square footage',
    manual: 'entered by you',
  }[a.lfSource] ?? 'entered by you';

  const rows = [
    ['How the footage was derived', sourceLabel],
    ['Gutter run', `${num(i.measuredLF)} LF`],
  ];
  if (Number.isFinite(a.perimeterFt)) {
    rows.push(['Building perimeter', `${Math.round(a.perimeterFt)} LF`]);
  }
  if (a.roofType) rows.push(['Roof type', `${a.roofType} (factor ${a.roofFactor})`]);
  rows.push(
    ['Waste factor', `${Math.round(a.wasteFactor * 100)}% → ${a.billableLF} billable LF`],
    ['Stories', String(i.stories)],
    ['Downspout rule', a.downspoutRule],
    ['Corners counted', String(i.corners)],
    ['Separate runs', String(i.runs)],
    ['Gutter guards', i.guards ? 'Included' : 'Not included'],
  );

  return `<dl class="assumptions">${rows.map(([k, v]) => `
    <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

export function renderResult(config, state) {
  if (!Number.isFinite(state.measuredLF) || state.measuredLF <= 0) {
    return `<section class="card">
      <span class="card__step">Your estimate</span>
      <h2>Enter your linear feet</h2>
      <p class="hint" style="margin:0">
        Your itemized price appears here as soon as you enter a footage above.
      </p>
    </section>`;
  }

  let r;
  try {
    r = estimate(config, state);
  } catch (err) {
    return `<section class="card">
      <div class="notice notice--error"><strong>Could not price this job.</strong>
      ${esc(err.message)}</div>
    </section>`;
  }

  const validity = config.rules.estimate_validity_days;
  const pct = Math.round(config.rules.estimate_range_pct * 100);

  return `
  <section class="card result">
    <span class="card__step">Your estimate</span>
    ${r.minimumApplied ? '<span class="result__flag">Minimum job price applied</span>' : ''}
    <p class="result__label">Estimated total</p>
    <p class="result__total">${money(r.total)}</p>
    <p class="result__band">
      Likely between ${money(r.lowBand)} and ${money(r.highBand)}
      &middot; &plusmn;${pct}%
    </p>
    <p class="result__note">
      ${esc(r.quantities.billableLF)} LF of ${esc(state.material.toLowerCase())}
      ${esc(state.profile)} gutter with ${esc(r.quantities.downspoutCount)} downspouts.
      Estimate valid ${esc(validity)} days, subject to a site visit.
    </p>
  </section>

  <section class="card">
    <span class="card__step">Line items</span>
    <h2>What you are paying for</h2>
    <p class="hint">
      Every item carries its SRR material code, so this converts straight into
      a work order.
    </p>
    ${renderLineItems(r)}
    ${renderUnpriced(r)}
  </section>

  <section class="card">
    <span class="card__step">Assumptions</span>
    <h2>What this price assumes</h2>
    ${renderAssumptions(r)}
    <p class="hint" style="margin:16px 0 0">
      This estimate is based on satellite imagery and the details you supplied,
      is subject to a site visit, and is valid for ${esc(validity)} days.
    </p>
  </section>

  <section class="card">
    <span class="card__step">Take it with you</span>
    <h2>Statement of work</h2>
    <p class="hint">
      A plain-text scope of work with the full line-item table, assumptions and
      exclusions &mdash; ready to paste into a contract.
    </p>
    <div class="actions">
      <button type="button" class="btn btn--primary" id="download-sow">Download .txt</button>
      <button type="button" class="btn btn--secondary" id="copy-sow">Copy to clipboard</button>
    </div>
    <p class="hint" id="sow-status" role="status" aria-live="polite" style="margin:10px 0 0"></p>
  </section>`;
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/**
 * Read the form into a new state object. Kept separate from rendering so the
 * state is always a plain snapshot the estimator can be handed directly.
 */
export function readForm(form, state) {
  const n = (name, fallback) => {
    const el = form.elements[name];
    if (!el) return fallback;
    const v = Number(el.value);
    return Number.isFinite(v) && el.value !== '' ? v : fallback;
  };

  const typedLF = n('measuredLF', null);

  return {
    ...state,
    addressLine: form.elements.addressLine?.value ?? state.addressLine,
    city: form.elements.city?.value ?? state.city,
    stateCode: form.elements.stateCode?.value ?? state.stateCode,
    zip: form.elements.zip?.value ?? state.zip,
    measuredLF: typedLF,
    stories: n('stories', state.stories),
    runs: Math.max(1, n('runs', 1)),
    corners: Math.max(0, n('corners', 0)),
    material: form.elements.material?.value ?? state.material,
    profile: form.elements.profile?.value ?? state.profile,
    guards: form.elements.guards?.checked ?? false,
    lfSource: 'manual',
  };
}
