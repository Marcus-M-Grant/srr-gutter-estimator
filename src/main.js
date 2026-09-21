/**
 * Entry point. Loads config, renders the form, keeps the estimate in sync.
 *
 * PHASE 6: address lookup, the building outline on a map, and the confirm
 * step. The estimator was never touched to add any of it - `estimate()` still
 * takes a plain inputs object and knows nothing about maps.
 */

import { loadConfig } from './config.js';
import { availableProfiles, estimate } from './estimator.js';
import { generateSow, sowFilename } from './sow.js';
import { generateSowPdf, pdfFilename } from './pdf.js';
import {
  measureAddress, deriveGutterRun, sqftToPerimeterFt,
  polygonPerimeterFt, countVertices, sideLengthsFt,
} from './geo.js';
import { renderBuildingMap } from './map.js';
import {
  initialState, renderForm, renderResult, renderMeasurement, readForm, esc,
  ROOF_TYPES, fullAddress, addressIsUsable,
} from './ui.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Sheet wiring lives in a committed root config.js. Missing is fine - the site
 * falls back to the /data snapshots and says so.
 */
async function getSheetConfig() {
  for (const path of ['../config.js', '../config.example.js']) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      return {
        sheetId: mod.SHEET_ID ?? '',
        pricingUrl: mod.PRICING_CSV_URL ?? '',
        rulesUrl: mod.RULES_CSV_URL ?? '',
      };
    } catch { /* not present - keep looking */ }
  }
  return { sheetId: '', pricingUrl: '', rulesUrl: '' };
}

function renderNotices(config) {
  const box = $('#notices');
  let html = '';

  if (config.errors.length) {
    html += `<div class="notice notice--error">
      <strong>Pricing could not be loaded safely, so no estimate is shown.</strong>
      Please call us and we will price this by hand.
      <ul>${config.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    </div>`;
  }
  // Warnings are for whoever maintains the sheet, not for a homeowner. Show
  // them only when explicitly asked for, so the customer-facing page stays clean.
  if (config.warnings.length && new URLSearchParams(location.search).has('debug')) {
    html += `<div class="notice">
      <strong>Config warnings (visible because of ?debug)</strong>
      <ul>${config.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>`;
  }
  box.innerHTML = html;
}

/** Push company details from the Rules tab into the page chrome. */
function applyCompanyDetails(rules) {
  const phone = String(rules.company_phone ?? '').trim();
  const name = String(rules.company_name ?? '').trim();
  const license = String(rules.company_license ?? '').trim();

  if (phone && phone.toUpperCase() !== 'TBD') {
    const tel = `tel:+1${phone.replace(/\D/g, '')}`;
    for (const id of ['topbar-phone', 'header-phone', 'footer-phone']) {
      const el = document.getElementById(id);
      if (el) { el.textContent = phone; el.setAttribute('href', tel); }
    }
  }
  if (name) $('#footer-company').textContent = name;
  if (license && license.toUpperCase() !== 'TBD') {
    $('#footer-license').textContent = `License #${license}`;
  }
}

function renderSource(config) {
  const live = config.source === 'sheet';
  $('#config-source').innerHTML =
    `Pricing: <span class="source-tag ${live ? 'source-tag--live' : ''}">` +
    `${live ? 'live' : 'saved snapshot'}</span>` +
    (live ? '' : ' &mdash; prices may be out of date.');
}

async function init() {
  const params = new URLSearchParams(location.search);
  const app = $('#app');

  let config;
  try {
    config = await loadConfig({
      ...(await getSheetConfig()),
      refresh: params.get('refresh') === '1',
      basePath: './',
    });
  } catch (err) {
    app.innerHTML = '';
    $('#notices').innerHTML = `<div class="notice notice--error">
      <strong>Could not load pricing.</strong> ${esc(err.message)}
    </div>`;
    console.error(err);
    return;
  }

  renderNotices(config);
  renderSource(config);
  applyCompanyDetails(config.rules);

  if (config.errors.length) {
    app.innerHTML = '';
    return;
  }

  let state = initialState(config);
  let mapHandle = null;

  // ---- the measurement chain ---------------------------------------------

  /** The whole editable chain, in one place. Pure maths lives in geo.js. */
  /** Inputs for the pricing engine, including measurement provenance. */
  function estimatorInputs() {
    const chain = currentChain();
    return {
      ...state,
      perimeterFt: chain?.perimeterFt ?? null,
      roofType: chain ? chain.roofLabel : null,
      roofFactor: chain?.roofFactor ?? null,
    };
  }

  function currentChain() {
    const m = state.measurement;
    if (!m?.ok) return null;
    const derived = deriveGutterRun({
      measurement: m,
      roofType: state.roofType,
      perimeterOverride: state.perimeterOverride,
      disabledSides: state.disabledSides,
      rules: config.rules,
    });
    const roof = ROOF_TYPES.find((r) => r.value === state.roofType);
    return { ...derived, roofLabel: roof?.label ?? 'Not sure' };
  }

  /**
   * Push the measured footage into the linear feet field - unless the customer
   * has typed their own. An edit must never be silently overwritten when
   * another field changes; `lfOverridden` is what protects that.
   */
  function applyMeasurementToLF({ force = false } = {}) {
    const chain = currentChain();
    if (!chain) return;
    if (state.lfOverridden && !force) return;
    state.measuredLF = Math.round(chain.gutterLF);
    // Provenance must follow the measurement, not be assumed. Method B is a
    // square-footage estimate and the statement of work has to say so rather
    // than claiming a building outline it never had.
    state.lfSource = state.measurement?.method === 'sqft' ? 'sqft' : 'osm';
    state.lfOverridden = false;
    state.buildingConfirmed = true;
  }

  async function drawMap() {
    mapHandle?.destroy();
    mapHandle = null;
    const el = document.getElementById('map');
    if (!el || !state.measurement?.ok) return;
    mapHandle = await renderBuildingMap(el, state.measurement, selectAlternative);
    if (!mapHandle) {
      // Leaflet or the tiles are unavailable. The estimate does not depend on
      // the picture, so say so quietly and carry on.
      el.innerHTML = '<p class="hint" style="padding:12px;margin:0">' +
        'The map could not load, so we cannot show you the outline. ' +
        'The footage below still comes from the building data.</p>';
    }
  }

  /**
   * Method B: derive a perimeter from floor area when there is no outline.
   * Produces a measurement-shaped object with no polygon, so the rest of the
   * chain, the assumptions block and the statement of work all keep working.
   */
  function useSquareFootage() {
    const totalSqFt = Number(document.getElementById('sqFt')?.value);
    const stories = Number(document.getElementById('sqFtStories')?.value) || 1;

    let b;
    try {
      b = sqftToPerimeterFt({ totalSqFt, stories, rules: config.rules });
    } catch {
      state.lookupError = 'Please enter the home square footage as a number.';
      renderAll();
      return;
    }

    state.measurement = {
      ok: true, method: 'sqft', lfSource: 'sqft',
      confidence: 'rough estimate',
      perimeterFt: b.perimeterFt,
      corners: 4, sideCount: 4,
      sides: [], coords: null, alternatives: [],
      candidateCount: 0, selection: 'square-footage',
      needsConfirmation: true, chosenDistanceFt: 0,
      footprintSqFt: b.footprintSqFt,
    };
    state.lookupStatus = 'done';
    state.perimeterOverride = null;
    state.disabledSides = [];
    state.sqFt = totalSqFt;
    state.sqFtStories = stories;
    state.sqFtOpen = false;
    applyMeasurementToLF({ force: true });
    renderAll();
  }

  /** The customer tapped a different outline: swap it in and remeasure. */
  function selectAlternative(index) {
    const m = state.measurement;
    const alt = m?.alternatives?.[index];
    if (!alt) return;

    const previous = {
      id: m.osmId, coords: m.coords,
      perimeterFt: m.perimeterFt,
      centroidDistanceFt: m.chosenDistanceFt,
    };
    const rest = m.alternatives.filter((_, i) => i !== index);

    state.measurement = {
      ...m,
      coords: alt.coords,
      osmId: alt.id,
      perimeterFt: alt.perimeterFt ?? polygonPerimeterFt(alt.coords),
      corners: countVertices(alt.coords),
      sideCount: countVertices(alt.coords),
      chosenDistanceFt: alt.centroidDistanceFt,
      selection: 'customer-chosen',
      confidence: 'confirmed by you',
      needsConfirmation: false,
      alternatives: [previous, ...rest],
    };
    // A different building means a different wall list, so any per-wall
    // choices made against the old one are meaningless now.
    state.disabledSides = [];
    state.perimeterOverride = null;
    state.measurement.sides = sideLengthsFt(alt.coords);
    applyMeasurementToLF({ force: true });
    renderAll();
  }

  async function runLookup() {
    if (!addressIsUsable(state)) {
      state.lookupStatus = 'error';
      state.lookupError =
        'Please fill in the street address plus a city or ZIP code.';
      renderAll();
      return;
    }
    const address = fullAddress(state);

    state.lookupStatus = 'looking';
    state.measurement = null;
    state.perimeterOverride = null;
    state.disabledSides = [];
    renderAll();

    let m;
    try {
      m = await measureAddress(address, { rules: config.rules });
    } catch (err) {
      m = { ok: false, reason: err.message };
    }

    if (m.ok) {
      state.measurement = m;
      state.lookupStatus = 'done';
      state.lookupError = '';
      applyMeasurementToLF();
    } else {
      state.measurement = null;
      state.lookupStatus = 'error';
      state.lookupError = m.reason ?? 'We could not measure that address.';
    }
    renderAll();
  }

  function rejectMeasurement() {
    mapHandle?.destroy();
    mapHandle = null;
    state.measurement = null;
    state.lookupStatus = state.sqFtOpen ? 'error' : 'idle';
    state.lookupError = state.sqFtOpen
      ? 'Right, that is not your building.' : '';
    state.perimeterOverride = null;
    state.disabledSides = [];
    state.buildingConfirmed = false;
    state.lfSource = 'manual';
    renderAll();
  }

  /**
   * Build the statement of work for the current state. The date is created
   * here and passed in, so sow.js itself stays pure and testable.
   */
  function currentSow() {
    const result = estimate(config, estimatorInputs());
    const date = new Date();
    return {
      text: generateSow(config, result, { address: fullAddress(state), date }),
      filename: sowFilename(fullAddress(state), date),
      result,
    };
  }

  function setSowStatus(msg) {
    const el = $('#sow-status');
    if (el) el.textContent = msg;
  }

  /** Hand the browser a blob to save. */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick; revoking synchronously cancels the download in
    // some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * Download the statement of work as a PDF, falling back to the plain text
   * version if jsPDF cannot be loaded. A blocked CDN should cost the customer
   * a nicer document, not the document.
   */
  async function downloadSow() {
    const btn = $('#download-sow');
    try {
      const { text, filename, result } = currentSow();
      const date = new Date();
      const address = fullAddress(state);

      if (btn) { btn.disabled = true; btn.textContent = 'Building PDF…'; }
      setSowStatus('');

      const blob = await generateSowPdf(config, result, { address, date });
      if (blob) {
        const name = pdfFilename(address, date);
        saveBlob(blob, name);
        setSowStatus(`Downloaded ${name}`);
      } else {
        saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
        setSowStatus(`PDF unavailable, so we saved ${filename} instead.`);
      }
    } catch (err) {
      setSowStatus(`Could not build the document: ${err.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download PDF'; }
    }
  }

  async function copySow() {
    let text;
    try {
      ({ text } = currentSow());
    } catch (err) {
      setSowStatus(`Could not build the document: ${err.message}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setSowStatus('Statement of work copied to the clipboard.');
    } catch {
      // Clipboard API needs a secure context and permission; fall back to a
      // selectable textarea rather than losing the document.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy');
      ta.remove();
      setSowStatus(ok
        ? 'Statement of work copied to the clipboard.'
        : 'Copying is blocked in this browser. Use Download .txt instead.');
    }
  }

  /** Re-render the result only. The form keeps its DOM so focus is not lost. */
  function updateResult() {
    $('#result').innerHTML = renderResult(config, estimatorInputs());
    $('#download-sow')?.addEventListener('click', downloadSow);
    $('#copy-sow')?.addEventListener('click', copySow);
    onEstimateComplete();
  }

  /**
   * The seam a future integration subscribes to (CRM writeback, analytics,
   * lead capture). Deliberately the only outward hook - see README future work.
   */
  function onEstimateComplete() {
    if (typeof window.onEstimateComplete !== 'function') return;
    try {
      window.onEstimateComplete(estimate(config, estimatorInputs()));
    } catch { /* an input mid-edit is not a valid estimate yet */ }
  }

  /** Full re-render. The map is redrawn afterwards, since it needs a live node. */
  function renderAll() {
    mapHandle?.destroy();
    mapHandle = null;
    app.innerHTML = renderForm(config, state)
                  + renderMeasurement(state, currentChain())
                  + '<div id="result"></div>';
    updateResult();
    bind();
    drawMap();
  }

  function bind() {
    const form = $('#estimate-form');

    $('#lookup-btn')?.addEventListener('click', runLookup);
    $('#use-measurement')?.addEventListener('click', () => {
      applyMeasurementToLF({ force: true });
      renderAll();
    });
    $('#reject-measurement')?.addEventListener('click', () => {
      // Offer the floor-area route rather than dead-ending them.
      state.sqFtOpen = true;
      rejectMeasurement();
    });
    $('#use-sqft')?.addEventListener('click', useSquareFootage);
    $('#show-sides')?.addEventListener('click', () => {
      state.showSides = true; renderAll();
    });
    $('#hide-sides')?.addEventListener('click', () => {
      state.showSides = false; renderAll();
    });
    $('#clear-perimeter')?.addEventListener('click', () => {
      state.perimeterOverride = null;
      applyMeasurementToLF({ force: true });
      renderAll();
    });

    // Editing the perimeter recalculates downstream immediately.
    $('#perimeter-input')?.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      state.perimeterOverride = Number.isFinite(v) && v > 0 ? v : null;
      applyMeasurementToLF({ force: true });
      renderAll();
    });

    for (const box of document.querySelectorAll('.side-toggle')) {
      box.addEventListener('change', () => {
        const idx = Number(box.dataset.side);
        const off = new Set(state.disabledSides);
        if (box.checked) off.delete(idx); else off.add(idx);
        state.disabledSides = [...off];
        applyMeasurementToLF({ force: true });
        renderAll();
      });
    }
    $('#recalc-from-address')?.addEventListener('click', () => {
      applyMeasurementToLF({ force: true });
      renderAll();
    });

    // Geocode on submit only. Never on keystroke - per-keystroke autocomplete
    // is an explicit violation of Nominatim's usage policy.
    for (const name of ['addressLine', 'city', 'stateCode', 'zip']) {
      form.elements[name]?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); runLookup(); }
      });
    }

    // The roof picker lives in the measurement card, OUTSIDE the form, so the
    // form's own input listener never sees it. Wire it directly.
    for (const radio of document.querySelectorAll('input[name="roofType"]')) {
      radio.addEventListener('change', () => {
        state.roofType = radio.value;
        applyMeasurementToLF();
        renderAll();
      });
    }

    form.addEventListener('input', (e) => {
      const previousMaterial = state.material;
      const previousRoof = state.roofType;
      const previousLF = state.measuredLF;

      state = readForm(form, state);

      // A hand-typed footage detaches from the measurement and must not be
      // overwritten when anything else changes.
      if (e.target?.name === 'measuredLF' && state.measuredLF !== previousLF) {
        state.lfOverridden = true;
        state.lfSource = 'manual';
      }

      void previousRoof;   // roof type is handled by its own listener above

      // Switching material can change which profiles exist, so reconcile the
      // selection before re-rendering rather than quoting a profile the new
      // material does not have.
      if (state.material !== previousMaterial) {
        const profiles = availableProfiles(config.pricing, state.material);
        if (!profiles.includes(state.profile)) {
          const preferred = config.rules.default_gutter_profile;
          state.profile = profiles.includes(preferred) ? preferred : profiles[0];
        }
        const focused = document.activeElement?.name;
        renderAll();
        // renderAll replaced the form, so re-query before restoring focus.
        if (focused) $('#estimate-form').elements[focused]?.focus?.();
        return;
      }
      updateResult();
    });

    form.addEventListener('submit', (e) => e.preventDefault());
  }

  renderAll();

  // Handy while building, and the seam a future integration subscribes to.
  window.SRR_CONFIG = config;
  window.SRR_STATE = () => state;
  console.log('SRR config loaded from', config.source, config);
}

init();
