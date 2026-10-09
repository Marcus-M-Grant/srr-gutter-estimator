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
import { qualifiesForWarranty } from './notify.js';
import { GUTTER_COLORS, colorsApply, chosenColor, colorHex } from './colors.js';

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

/**
 * Gutter profiles drawn as cross-sections.
 *
 * A homeowner has no idea what "K Style 5 inch" means, and a photograph of a
 * gutter on a house shows the fascia, not the shape. The cross-section is the
 * thing that actually differs between profiles, so it is what we draw. Inline
 * SVG also keeps this keyless and free, with nothing to licence.
 *
 * Matched on a keyword so any profile the sheet adds still gets a picture.
 */
// Each entry can take `photo: 'assets/gutters/<name>.jpg'` (480x320, 3:2);
// the tile then shows the photo in place of the drawing. Use photos SRR owns:
// the free-licensed ones found so far were too unclear at tile size.
const PROFILE_ART = [
  {
    match: /half\s*round/i,
    hint: 'Rounded, traditional',
    svg: '<path d="M10 12 A17 17 0 0 0 44 12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
       + '<path d="M10 12 L6 10 M44 12 L48 10" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  },
  {
    match: /box/i,
    hint: 'Deep and square, high capacity',
    svg: '<path d="M12 8 L12 34 L42 34 L42 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>'
       + '<path d="M12 8 L7 6 M42 8 L47 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  },
  {
    match: /fascia/i,
    hint: 'Flat face, hides the rafter ends',
    svg: '<path d="M13 7 L13 33 L41 33 L43 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>'
       + '<path d="M43 7 L47 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  },
  {
    match: /k\s*style/i,
    hint: 'The common one, crown-moulding look',
    svg: '<path d="M14 6 L14 33 L34 33 L34 25 Q34 21 39 19 Q43 17 43 12 L43 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>'
       + '<path d="M14 6 L9 4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  },
];

const GENERIC_PROFILE_ART =
  '<path d="M13 8 L13 33 L41 33 L41 8" fill="none" stroke="currentColor" '
  + 'stroke-width="2.6" stroke-linejoin="round" stroke-dasharray="4 3"/>';

/** Picture and one-line description for a profile name from the sheet. */
export function profileArt(profile) {
  const hit = PROFILE_ART.find((a) => a.match.test(String(profile ?? '')));
  return hit
    ? { svg: hit.svg, hint: hit.hint, photo: hit.photo ?? null }
    : { svg: GENERIC_PROFILE_ART, hint: '', photo: null };
}

/**
 * Which materials to put in front of a customer.
 *
 * The sheet still prices copper, and the estimator still handles it, but SRR
 * only sells aluminium through this tool. `materials_offered` on the Rules tab
 * controls it - a comma separated list. Absent, it means aluminium only.
 */
export function offeredMaterials(config) {
  const available = availableMaterials(config.pricing);
  const raw = String(config.rules?.materials_offered ?? 'Aluminum').trim();
  if (raw === '*') return available;

  const wanted = raw.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
  const offered = available.filter((m) => wanted.includes(m.toLowerCase()));
  // Never leave the customer with nothing to pick, whatever the sheet says.
  return offered.length ? offered : available;
}

export function initialState(config) {
  const materials = offeredMaterials(config);
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
    lookupReasonCode: null,   // no-address | no-outline | outline-service
    lookupPoint: null,        // where the address geocoded, even with no outline
    traceCorners: [],         // corners the customer tapped (Method A2)
    tracePerimeterFt: 0,
    contact: { name: '', phone: '', email: '' },   // optional, for the estimate
    contactErrors: {},
    color: null,              // a GUTTER_COLORS name; null until they pick
    styleTouched: false,      // progress bar: they chose stories, shape, etc.
    estimateSaved: false,     // progress bar: they downloaded or copied it
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

/**
 * Roof type, as one compact row of four small icon buttons. Only shown with a
 * measured outline: it decides how much of that outline gets gutter, and has
 * nothing to act on when the customer typed their linear feet directly.
 * Defaults to "Not sure", so skipping it is fine.
 */
export function renderRoofPicker(state, chain) {
  const muted = chain && chain.roofFactorApplies === false;
  return `
  <fieldset class="fieldset ${muted ? 'is-muted' : ''}">
    <legend>Roof type${muted
      ? ' <span class="sub">&mdash; not used, you picked walls</span>' : ''}</legend>
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
        ${off.size} wall${off.size > 1 ? 's' : ''} switched off.
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
function renderSqFtFallback(state, heading = 'Estimate from the size of the home instead') {
  return `
  <div class="fallback">
    <p class="fallback__head">${heading}</p>
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

/**
 * Method A2 as a UI: trace the roof on the satellite picture. The readout and
 * button states are updated in place by main.js as corners are tapped, so the
 * map is not rebuilt (and the customer's zoom lost) on every tap.
 */
export function traceReadout(corners, perimeterFt) {
  const n = corners?.length ?? 0;
  if (n === 0) return 'Tap the first corner of your roof.';
  if (n < 3) return `${n} corner${n === 1 ? '' : 's'} placed &mdash; keep going around the roof.`;
  return `${n} corners, about <strong>${Math.round(perimeterFt)} ft</strong> around.
    Tap more corners for bump-outs, or use this outline.`;
}

function renderTracePanel(state) {
  const corners = state.traceCorners ?? [];
  const ready = corners.length >= 3;
  return `
    <div class="map-wrap">
      <div id="trace-map" class="map map--trace" role="application"
           aria-label="Satellite view of your address. Tap the corners of your roof."></div>
      <span class="map-badge map-badge--check">tap the corners</span>
    </div>
    <p class="hint trace-readout" id="trace-readout" aria-live="polite">
      ${traceReadout(corners, state.tracePerimeterFt ?? 0)}
    </p>
    <div class="actions">
      <button type="button" class="btn btn--primary" id="use-trace" ${ready ? '' : 'disabled'}>
        Use this outline
      </button>
      <button type="button" class="btn btn--ghost" id="undo-trace" ${corners.length ? '' : 'disabled'}>
        Undo corner
      </button>
      <button type="button" class="btn btn--ghost" id="clear-trace" ${corners.length ? '' : 'disabled'}>
        Start over
      </button>
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
/**
 * The measurement sits INSIDE the job card, directly under the address block,
 * so the map appears where the customer just typed rather than below every
 * other question. It is a plain block, not a card - a card nested inside a
 * card reads as a separate step, which is the opposite of the point.
 */
export function renderMeasurement(state, chain) {
  if (state.lookupStatus === 'looking') {
    return `<div class="measure" id="measurement">
      <h2>Looking up your building&hellip;</h2>
      <p class="hint" style="margin:0">
        Checking the public building outline for that address&hellip;
      </p>
    </div>`;
  }

  if (state.lookupStatus === 'error' && state.lookupPoint) {
    // The address WAS found - only the building outline is missing (or the
    // outline service is down). Saying "we could not find that building" here
    // reads as "we could not find your address", which is wrong and sends
    // people off retyping a perfectly good address. Let them trace it instead.
    return `<div class="measure" id="measurement">
      <h3 class="measure__title">We found your address &mdash; now outline your roof</h3>
      <p class="hint">
        ${state.lookupReasonCode === 'no-outline'
          ? 'Public map data does not have your building drawn in yet, so we cannot measure it automatically.'
          : esc(state.lookupError)}
        Tap each corner of your roof on the picture, in order, and we will measure
        it. Drag a corner to adjust it.
      </p>
      ${renderTracePanel(state)}
      ${renderSqFtFallback(state, 'Or estimate from the size of the home')}
    </div>`;
  }

  if (state.lookupStatus === 'error') {
    const notFound = state.lookupReasonCode === 'no-address';
    return `<div class="measure" id="measurement">
      <h2>${notFound ? 'We could not find that address' : 'We could not find that building'}</h2>
      <div class="notice"><strong>${esc(state.lookupError)}</strong>
        ${notFound ? `Check the street number and ZIP, and leave off any unit or
          apartment number. Still stuck? Give us the size of the home instead, or
          just type the linear feet below.` : `No problem. Give us the size of the
          home instead, or just type the linear feet below.`}
        An estimator confirms the real footage on site.
      </div>
      ${renderSqFtFallback(state)}
    </div>`;
  }

  const m = state.measurement;
  if (!m?.ok) return '';

  return `
  <div class="measure" id="measurement">
    <h3 class="measure__title">${m.method === 'sqft'
      ? 'Estimated from the floor area'
      : m.method === 'traced' ? 'Your roof outline' : 'Is this your building?'}</h3>
    ${m.method === 'sqft' ? `
    <p class="hint">
      Worked out from ${Math.round(m.footprintSqFt)} sq ft of footprint. This is a
      rough estimate, not a measurement of your building.
    </p>` : m.method === 'traced' ? `
    <p class="hint">
      Measured from the corners you tapped. Switch off any wall without gutter
      below &mdash; a Specialist Roofing estimator confirms exact footage on site.
    </p>` : ''}

    ${m.coords ? `
    <div class="map-wrap">
      <div id="map" class="map" role="img"
           aria-label="Satellite view with your building outlined"></div>
      <span class="map-badge map-badge--${m.needsConfirmation ? 'check' : 'ok'}">
        ${esc(m.confidence)}
      </span>
    </div>` : ''}

    ${renderSides(state, m)}

    ${m.method === 'sqft' ? '' : renderRoofPicker(state, chain)}

    <div class="actions" style="margin-top:4px">
      <button type="button" class="btn btn--primary" id="use-measurement">
        ${state.buildingConfirmed ? 'Footage applied' : 'Yes, use this footage'}
      </button>
      <button type="button" class="btn btn--ghost" id="reject-measurement">
        ${m.method === 'traced' ? 'Redraw outline' : 'Not my building'}
      </button>
    </div>
    ${state.sqFtOpen ? renderSqFtFallback(state) : ''}
  </div>`;
}

export function renderForm(config, state, measurementHtml = '') {
  const materials = offeredMaterials(config);
  const profiles = availableProfiles(config.pricing, state.material);
  const canGuard = guardsAvailable(config.pricing, state.material, state.profile);

  // Only ask for something that changes the answer. When end caps and miters
  // are covered by the gutter price rather than itemised, these two inputs
  // drive nothing, and asking anyway wastes the customer's time.
  const showRuns = Number(config.rules.end_caps_per_run) > 0;
  const showCorners = Number(config.rules.miters_per_corner ?? 1) > 0;

  return `
  <form id="estimate-form" class="card" novalidate>
    <h2>Tell us about the job</h2>
    <p class="hint">
      Start with your address and we will measure the building for you, or skip
      it and type the linear feet yourself.
    </p>

    <div class="start-split">
      <div class="start-split__col">
        <p class="start-split__head">Measure from my address</p>
        <div class="field">
          <input type="text" id="addressLine" name="addressLine" aria-label="Street address"
                 autocomplete="address-line1" placeholder="1061 N Victory Pl"
                 value="${esc(state.addressLine ?? '')}">
        </div>

        <div class="addr-grid">
          <div class="field">
            <input type="text" id="city" name="city" aria-label="City"
                   autocomplete="address-level2" placeholder="Burbank"
                   value="${esc(state.city ?? '')}">
          </div>
          <div class="field">
            <input type="text" id="stateCode" name="stateCode" aria-label="State"
                   autocomplete="address-level1" maxlength="2" placeholder="CA"
                   value="${esc(state.stateCode ?? '')}">
          </div>
          <div class="field">
            <input type="text" id="zip" name="zip" aria-label="ZIP code"
                   autocomplete="postal-code" inputmode="numeric" maxlength="10"
                   placeholder="91502" value="${esc(state.zip ?? '')}">
          </div>
        </div>

        <button type="button" class="btn btn--secondary btn--block" id="lookup-btn"
                ${state.lookupStatus === 'looking' ? 'disabled' : ''}>
          ${state.lookupStatus === 'looking'
            ? 'Looking up your building&hellip;'
            : 'Find my building'}
        </button>
      </div>

      <div class="start-split__or" aria-hidden="true"><span>or</span></div>

      <div class="start-split__col">
        <p class="start-split__head">I know my linear feet of gutter</p>
        <div class="field">
          <input type="number" id="measuredLF" name="measuredLF" inputmode="numeric"
                 aria-label="Linear feet of gutter"
                 min="1" max="5000" step="1" placeholder="e.g. 200"
                 value="${state.measuredLF ?? ''}">
          ${state.lfOverridden && state.measurement?.ok ? `
            <p class="hint" style="margin:6px 0 0">
              Using your figure. <button type="button" class="linkish"
                id="recalc-from-address">Recalculate from the address</button>
            </p>` : ''}
        </div>
      </div>
    </div>

    ${measurementHtml}

    <fieldset class="fieldset" id="style-step">
      <legend>Number of stories</legend>
      ${radioGroup('stories', [
        { value: 1, label: '1 story' },
        { value: 2, label: '2 stories' },
        { value: 3, label: '3 stories' },
      ], state.stories)}
    </fieldset>

    ${materials.length > 1 ? `
    <fieldset class="fieldset">
      <legend>Material</legend>
      ${radioGroup('material', materials.map((m) => ({ value: m, label: m })), state.material)}
    </fieldset>` : ''}

    <fieldset class="fieldset">
      <legend>Gutter shape
        <span class="sub">&mdash; how it looks from the end</span></legend>
      <div class="profiles">
        ${profiles.map((p) => {
          const art = profileArt(p);
          return `
          <label class="profile">
            <input type="radio" name="profile" value="${esc(p)}"
                   ${p === state.profile ? 'checked' : ''}>
            <span class="profile__box ${art.photo ? 'has-photo' : ''}">
              ${art.photo
                ? `<img class="profile__photo" src="${art.photo}" alt=""
                        width="480" height="320">`
                : `<span class="profile__drawing"><svg viewBox="0 0 54 40" class="profile__svg"
                        aria-hidden="true">${art.svg}</svg></span>`}
              <span class="profile__name">${esc(p)}</span>
              ${art.hint ? `<span class="profile__hint">${esc(art.hint)}</span>` : ''}
            </span>
          </label>`;
        }).join('')}
      </div>
    </fieldset>

    ${colorsApply(state.material) ? renderColorPicker(state) : ''}

    ${(showRuns || showCorners) ? `
    <div class="two-up">
      ${showRuns ? `
      <div class="field">
        <label for="runs">Separate gutter runs <span class="sub">&mdash; end caps</span></label>
        <input type="number" id="runs" name="runs" inputmode="numeric"
               min="1" max="20" step="1" value="${state.runs}">
      </div>` : ''}
      ${showCorners ? `
      <div class="field">
        <label for="corners">Corners <span class="sub">&mdash; miters</span></label>
        <input type="number" id="corners" name="corners" inputmode="numeric"
               min="0" max="40" step="1" value="${state.corners}">
      </div>` : ''}
    </div>` : ''}

    ${canGuard ? `
    <div class="field">
      <label class="switch">
        <input type="checkbox" id="guards" name="guards" ${state.guards ? 'checked' : ''}>
        <span class="switch__text">Add gutter guards <span class="sub">(sized to match your gutter)</span></span>
      </label>
    </div>` : ''}
  </form>`;
}

/**
 * Gutter color: one button in the form, and the 20 swatches in a panel it
 * opens. Laid out inline, the swatches made a ragged grid that dominated the
 * page; behind a button they take one line until the customer wants them.
 *
 * Optional, nothing pre-selected - a color the customer did not choose should
 * not end up on their estimate. Price does not depend on it.
 */
export function renderColorPicker(state) {
  const color = chosenColor(state);
  const hex = colorHex(color);
  return `
    <fieldset class="fieldset">
      <legend>Gutter color <span class="sub">&mdash; optional</span></legend>
      <button type="button" class="color-pick ${color ? 'has-color' : ''}" id="open-colors"
              aria-haspopup="dialog">
        <span class="color-pick__chip ${color ? '' : 'color-pick__chip--any'}"
              ${hex ? `style="background:${hex}"` : ''} aria-hidden="true"></span>
        <span class="color-pick__text">${color ? esc(color) : 'Select your gutter color here'}</span>
        <span class="color-pick__action">${color ? 'Change' : 'Choose'}</span>
      </button>
      ${renderColorDialog(color)}
    </fieldset>`;
}

export function renderColorDialog(selected) {
  return `
    <dialog class="color-dialog" id="color-dialog" aria-labelledby="color-dialog-title">
      <div class="color-dialog__head">
        <h3 id="color-dialog-title">Choose your gutter color</h3>
        <button type="button" class="color-dialog__close" data-close-colors
                aria-label="Close">&times;</button>
      </div>
      <div class="colors">
        ${GUTTER_COLORS.map((c) => `
        <button type="button" class="color" data-color="${esc(c.name)}"
                aria-pressed="${selected === c.name}">
          <span class="color__chip" style="background:${c.hex}" aria-hidden="true"></span>
          <span class="color__name">${esc(c.name)}</span>
        </button>`).join('')}
      </div>
      <div class="color-dialog__foot">
        <p class="hint" style="margin:0">Screen colors are a guide &mdash; we confirm with a real sample.</p>
        ${selected ? '<button type="button" class="linkish" data-color="">No preference yet</button>' : ''}
      </div>
    </dialog>`;
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


export function renderResult(config, state) {
  if (!Number.isFinite(state.measuredLF) || state.measuredLF <= 0) {
    return `<section class="card">
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
    ${r.minimumApplied ? '<span class="result__flag">Minimum job price applied</span>' : ''}
    <p class="result__label">Estimated total</p>
    <p class="result__total">${money(r.total)}</p>
    <p class="result__band">
      Likely between ${money(r.lowBand)} and ${money(r.highBand)}
      &middot; &plusmn;${pct}%
    </p>
    <p class="result__note">
      ${esc(r.quantities.billableLF)} LF of ${esc(state.material.toLowerCase())}
      ${esc(state.profile)} gutter${chosenColor(state) ? ` in ${esc(chosenColor(state))}` : ''}
      with ${esc(r.quantities.downspoutCount)} downspouts.
      Estimate valid ${esc(validity)} days, subject to a site visit.
    </p>
  </section>

  <section class="card">
    <h2>What you are paying for</h2>
    ${renderLineItems(r)}
    ${renderUnpriced(r)}
  </section>

  <section class="card">
    <h2>Statement of work</h2>
    <p class="hint">
      A PDF with the full line-item breakdown, scope of work and exclusions
      &mdash; ready to print, email or attach to a contract.
    </p>
    ${renderContactFields(state)}
    <div class="actions">
      <button type="button" class="btn btn--primary" id="download-sow">Download PDF</button>
    </div>
    <p class="hint" id="sow-status" role="status" aria-live="polite" style="margin:10px 0 0"></p>
  </section>`;
}

/**
 * The progress bar. Four steps, each ticked off by something the customer
 * actually did, so the bar only ever moves because of them. The gutter style
 * questions come pre-answered, so that step counts once they have touched one
 * (or carried on to the estimate, which accepts the defaults).
 */
export const PROGRESS_STEPS = [
  { key: 'address', label: 'Address', target: 'addressLine' },
  { key: 'measure', label: 'Measure', target: 'measuredLF' },
  { key: 'style', label: 'Gutter style', target: 'style-step' },
  { key: 'estimate', label: 'Your estimate', target: 'contact-block' },
];

export function progressSteps(state) {
  const measured = Number.isFinite(state.measuredLF) && state.measuredLF > 0;
  const done = {
    address: addressIsUsable(state),
    measure: measured,
    style: measured && (state.styleTouched || state.estimateSaved),
    estimate: !!state.estimateSaved,
  };
  const firstOpen = PROGRESS_STEPS.findIndex((s) => !done[s.key]);
  return PROGRESS_STEPS.map((s, i) => ({
    ...s, done: done[s.key], current: i === firstOpen,
  }));
}

export function renderProgress(state) {
  const steps = progressSteps(state);
  const count = steps.filter((s) => s.done).length;
  const pct = Math.round((count / steps.length) * 100);
  return `
  <div class="wrap progress__inner">
    <div class="progress__track" role="progressbar" aria-label="Estimate progress"
         aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${count}">
      <div class="progress__fill" style="width:${pct}%"></div>
    </div>
    <ol class="progress__steps">
      ${steps.map((s, i) => `
      <li class="progress__step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}">
        <button type="button" data-target="${s.target}"
                ${s.current ? 'aria-current="step"' : ''}>
          <span class="progress__dot" aria-hidden="true">${s.done ? '&#10003;' : i + 1}</span>
          <span class="progress__label">${esc(s.label)}</span>
        </button>
      </li>`).join('')}
    </ol>
  </div>`;
}

/**
 * The same four steps as a vertical rail down the left of the page, for
 * screens wide enough to have a margin there. It stays put while the page
 * scrolls, so "almost done" is always in view - the top bar is easy to stop
 * noticing. The line fills to the step the customer is on.
 */
export function progressMessage(count, total) {
  if (count >= total) return 'All done!';
  if (count === total - 1) return 'Almost done!';
  if (count === 0) return 'Let&rsquo;s get started';
  return `${count} of ${total} done`;
}

export function renderProgressRail(state) {
  const steps = progressSteps(state);
  const n = steps.length;
  const count = steps.filter((s) => s.done).length;
  const fill = Math.round((Math.min(count, n - 1) / (n - 1)) * 100);
  return `
    <p class="rail__head">Your estimate</p>
    <p class="rail__msg">${progressMessage(count, n)}</p>
    <div class="rail__track">
    <div class="rail__bar" role="progressbar" aria-label="Estimate progress"
         aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${count}">
      <div class="rail__fill" style="height:${fill}%"></div>
    </div>
    <ol class="rail__steps">
      ${steps.map((s, i) => `
      <li class="rail__step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}">
        <button type="button" data-target="${s.target}"
                ${s.current ? 'aria-current="step"' : ''}>
          <span class="rail__dot" aria-hidden="true">${s.done ? '&#10003;' : i + 1}</span>
          <span class="rail__label">${esc(s.label)}</span>
        </button>
      </li>`).join('')}
    </ol>
    </div>`;
}

/** The live "you qualify" line under the contact fields. */
export function warrantyStatus(contact) {
  return qualifiesForWarranty(contact)
    ? '&#10003; You qualify for the free 10-year warranty. It will be on your estimate.'
    : '';
}

/**
 * Optional contact details, asked for at the moment the customer wants the
 * PDF - the point where a name on the document is worth something to them.
 * Nothing here is required; the download works with every box empty.
 *
 * These inputs sit OUTSIDE the estimate form, so typing in them never
 * re-prices or re-renders anything. Their values live in state.contact so a
 * re-render from the form above does not wipe what was typed.
 */
export function renderContactFields(state) {
  const c = state.contact ?? {};
  const e = state.contactErrors ?? {};
  const err = (k) => (e[k]
    ? `<p class="field__error" id="contact-${k}-error">${esc(e[k])}</p>` : '');
  const desc = (k) => (e[k] ? ` aria-describedby="contact-${k}-error" aria-invalid="true"` : '');
  return `
    <div class="contact" id="contact-block">
      <p class="contact__head">
        Add your details to the estimate <span class="sub">&mdash; optional</span>
      </p>
      <p class="hint" style="margin:0 0 12px">
        Add your name and a phone or email to qualify for a
        <strong>free 10-year warranty</strong> on your gutters when you go with us.
      </p>
      <div class="field">
        <label for="contact-name">Name</label>
        <input type="text" id="contact-name" autocomplete="name" maxlength="100"
               value="${esc(c.name ?? '')}">
      </div>
      <div class="two-up">
        <div class="field">
          <label for="contact-phone">Phone</label>
          <input type="tel" id="contact-phone" autocomplete="tel" inputmode="tel"
                 maxlength="40" placeholder="(626) 555-0100"
                 value="${esc(c.phone ?? '')}"${desc('phone')}>
          ${err('phone')}
        </div>
        <div class="field">
          <label for="contact-email">Email</label>
          <input type="email" id="contact-email" autocomplete="email" maxlength="200"
                 value="${esc(c.email ?? '')}"${desc('email')}>
          ${err('email')}
        </div>
      </div>
      <p class="warranty-status" id="warranty-status" aria-live="polite">
        ${warrantyStatus(c)}
      </p>
      <div class="hp" aria-hidden="true">
        <label for="contact-website">Leave this empty</label>
        <input type="text" id="contact-website" tabindex="-1" autocomplete="off">
      </div>
    </div>`;
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
