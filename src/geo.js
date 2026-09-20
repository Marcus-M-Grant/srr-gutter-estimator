/**
 * Address -> linear feet of gutter.
 *
 * THE MEASUREMENT DOES NOT COME FROM THE SATELLITE PICTURE. It comes from
 * OpenStreetMap vector building footprints: actual coordinate lists, from
 * which the perimeter is plain trigonometry. The imagery is cosmetic - it
 * exists so the customer can say "yes, that is my house" - so the map can fail
 * to load and the estimate still works.
 *
 * Everything above `measureAddress` is pure: no fetch, no DOM, no clock. That
 * is the part the tests drive with fixtures. The network layer is a thin shell
 * on top.
 *
 * Etiquette: Overpass and Nominatim are volunteer funded. Cache hard, time out
 * at 15s, identify ourselves, geocode only on submit (never per keystroke -
 * that is an explicit violation of Nominatim's policy), and fall through to
 * the square-footage method rather than retrying in a loop.
 */

import {
  GEOCODER_CENSUS, GEOCODER_CENSUS_PARAMS, GEOCODER_NOMINATIM,
  OVERPASS, OVERPASS_MIRROR, NETWORK_TIMEOUT_MS, USER_AGENT,
} from './providers.js';

const EARTH_RADIUS_M = 6371008.8;   // WGS84 mean radius
const M_TO_FT = 3.28084;
// Tried in order; stop at the first radius that returns any building.
const SEARCH_RADII_M = [30, 60];
const SEARCH_RADIUS_M = SEARCH_RADII_M[0];
const CACHE_PREFIX = 'srr-geo-v1:';
/**
 * Per endpoint. Overpass is legitimately slow under load - a tight cap turns
 * healthy-but-busy lookups into false misses, which is worse than waiting.
 * Only two endpoints are ever tried, and only for a radius that came back
 * empty rather than errored, so the worst case stays bounded.
 */
const OVERPASS_TIMEOUT_MS = 15000;

/** Defaults used only when the Rules tab has not supplied the key. */
export const GEO_DEFAULTS = {
  gutter_factor_gable: 0.62,
  gutter_factor_hip: 1.00,
  gutter_factor_flat: 0.95,
  gutter_factor_unknown: 0.80,
  overhang_allowance_ft: 1.0,
  footprint_shape_factor: 1.12,
};

const rule = (rules, key) =>
  Number.isFinite(rules?.[key]) ? rules[key] : GEO_DEFAULTS[key];

// ---------------------------------------------------------------------------
// pure geometry
// ---------------------------------------------------------------------------

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance between two {lat, lon} points, in feet. */
export function haversineFt(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)) * M_TO_FT;
}

/** Drop the duplicate closing vertex OSM includes on a closed way. */
export function openRing(coords) {
  if (coords.length < 2) return coords.slice();
  const first = coords[0];
  const last = coords[coords.length - 1];
  const same = Math.abs(first.lat - last.lat) < 1e-9
            && Math.abs(first.lon - last.lon) < 1e-9;
  return same ? coords.slice(0, -1) : coords.slice();
}

/** Perimeter of a closed ring, in feet. */
export function polygonPerimeterFt(coords) {
  const ring = openRing(coords);
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    total += haversineFt(ring[i], ring[(i + 1) % ring.length]);
  }
  return total;
}

/** Vertex count of the footprint, which is the corner estimate. */
export function countVertices(coords) {
  return openRing(coords).length;
}

/** Each wall with its length, so the customer can switch a side off. */
export function sideLengthsFt(coords) {
  const ring = openRing(coords);
  if (ring.length < 3) return [];
  return ring.map((p, i) => ({
    index: i,
    lengthFt: haversineFt(p, ring[(i + 1) % ring.length]),
    from: p,
    to: ring[(i + 1) % ring.length],
  }));
}

export function polygonCentroid(coords) {
  const ring = openRing(coords);
  if (!ring.length) return null;
  const sum = ring.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
    { lat: 0, lon: 0 });
  return { lat: sum.lat / ring.length, lon: sum.lon / ring.length };
}

/** Ray casting. Good enough at building scale, where the earth is flat. */
export function pointInPolygon(point, coords) {
  const ring = openRing(coords);
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    const intersects = (yi > point.lat) !== (yj > point.lat)
      && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Pick the building the geocoded point belongs to.
 * Containing polygon first; failing that the nearest centroid. When several
 * are close the caller shows them all and lets the customer tap theirs, so the
 * full sorted list comes back too.
 */
export function chooseBuilding(candidates, point) {
  if (!candidates?.length) return { chosen: null, ranked: [], reason: 'none' };

  const withDistance = candidates.map((c) => {
    const centroid = polygonCentroid(c.coords);
    return {
      ...c,
      centroid,
      contains: pointInPolygon(point, c.coords),
      centroidDistanceFt: centroid ? haversineFt(point, centroid) : Infinity,
    };
  });

  // Rank EVERY candidate: a polygon containing the point beats one that does
  // not, then nearest centroid breaks the tie. `ranked` stays complete on
  // purpose - the losers are what the UI offers as "not this one?", so
  // filtering them out here would silently empty that list.
  const ranked = [...withDistance].sort((a, b) => {
    if (a.contains !== b.contains) return a.contains ? -1 : 1;
    return a.centroidDistanceFt - b.centroidDistanceFt;
  });

  return {
    chosen: ranked[0],
    ranked,
    reason: ranked[0].contains ? 'contains-point' : 'nearest-centroid',
  };
}

/**
 * How much to trust the building we picked.
 *
 * Measured against real addresses, the geocoded point landed inside a building
 * polygon ZERO times out of eight - both the Census geocoder and Nominatim
 * return a street-front point. So 'high' is reserved for the rare clean case,
 * and anything with neighbours in range is explicitly flagged for the customer
 * to confirm rather than being presented as a measurement.
 */
export function gradeConfidence(selectionReason, candidateCount) {
  if (selectionReason === 'contains-point' && candidateCount === 1) return 'high';
  if (selectionReason === 'contains-point') return 'good';
  if (candidateCount === 1) return 'likely';
  return 'needs confirmation';
}

/**
 * PERIMETER IS NOT GUTTER FOOTAGE. Gutter hangs on eaves, not rakes: a gable
 * roof gets gutter on roughly two of four sides. This is the single most
 * important correction in the whole calculation.
 *
 *   gutterLF = perimeterFt * roofFactor + overhang_allowance_ft * sideCount
 */
export function roofFactorFor(roofType, rules) {
  const key = {
    gable: 'gutter_factor_gable',
    hip: 'gutter_factor_hip',
    flat: 'gutter_factor_flat',
  }[String(roofType ?? '').toLowerCase()] ?? 'gutter_factor_unknown';
  return rule(rules, key);
}

export function perimeterToGutterLF({ perimeterFt, sideCount = 4, roofType, rules }) {
  const roofFactor = roofFactorFor(roofType, rules);
  const overhang = rule(rules, 'overhang_allowance_ft');
  const gutterLF = perimeterFt * roofFactor + overhang * sideCount;
  return { gutterLF, roofFactor, overhangAllowanceFt: overhang, sideCount };
}

/**
 * The editable chain from spec 6.5, as one pure function.
 *
 *   building perimeter  ->  [which walls get gutter]  ->  [roof type]  ->  run
 *
 * THE MODELLING DECISION THAT MATTERS: the roof factor and the per-side
 * toggles answer the same question by different means. `gutter_factor_gable`
 * of 0.62 is an *estimate* that roughly two of four sides are eaves. Ticking
 * walls off is the customer stating it *exactly*. Applying both would subtract
 * the same thing twice and under-quote badly - a gable job with two walls
 * switched off would come out at 0.62 x 0.5 = 31% of perimeter instead of 50%.
 *
 * So the moment the customer touches a wall toggle, their selection wins and
 * the roof factor stops applying (`roofFactorApplies: false`). The UI says so
 * out loud rather than silently changing the maths under them.
 *
 * @param {object}  input
 * @param {object}  [input.measurement]        a measureAddress result
 * @param {string}  [input.roofType]
 * @param {number}  [input.perimeterOverride]  a perimeter the customer typed
 * @param {number[]}[input.disabledSides]      indices of walls with no gutter
 * @param {object}  [input.rules]
 */
export function deriveGutterRun({
  measurement, roofType = 'unknown', perimeterOverride = null,
  disabledSides = [], rules = {},
} = {}) {
  const sides = measurement?.sides ?? [];
  const off = new Set(disabledSides);
  const perimeterEdited = Number.isFinite(perimeterOverride) && perimeterOverride > 0;

  // A typed perimeter supersedes the wall list completely: the walls no longer
  // add up to it, so they cannot narrow it and must not influence whether the
  // roof factor applies either.
  const sidesEdited = !perimeterEdited && sides.length > 0 && off.size > 0;

  let perimeterFt;
  let sideCount;
  let source;

  if (perimeterEdited) {
    // A typed perimeter replaces the outline entirely, so the wall list no
    // longer adds up to it and cannot be applied on top.
    perimeterFt = perimeterOverride;
    sideCount = measurement?.sideCount ?? 4;
    source = 'perimeter-edited';
  } else if (sidesEdited) {
    const on = sides.filter((s) => !off.has(s.index));
    perimeterFt = on.reduce((sum, s) => sum + s.lengthFt, 0);
    sideCount = on.length;
    source = 'sides-selected';
  } else {
    perimeterFt = measurement?.perimeterFt ?? 0;
    sideCount = measurement?.sideCount ?? 4;
    source = measurement?.ok ? 'outline' : 'none';
  }

  const roofFactorApplies = !sidesEdited;
  const roofFactor = roofFactorApplies ? roofFactorFor(roofType, rules) : 1;
  const overhang = rule(rules, 'overhang_allowance_ft');
  const gutterLF = perimeterFt * roofFactor + overhang * sideCount;

  return {
    perimeterFt, sideCount, roofFactor, roofFactorApplies,
    overhangAllowanceFt: overhang, gutterLF, source,
    disabledCount: sidesEdited ? off.size : 0,
  };
}

/**
 * Method B: square footage maths, for addresses OSM has no footprint for.
 * A perfect square has perimeter 4*sqrt(area); real houses are rectangular
 * with bump-outs, which is what footprint_shape_factor corrects for.
 */
export function sqftToPerimeterFt({ totalSqFt, stories = 1, rules }) {
  const s = Math.max(1, Number(stories) || 1);
  const footprintSqFt = Number(totalSqFt) / s;
  if (!Number.isFinite(footprintSqFt) || footprintSqFt <= 0) {
    throw new Error('totalSqFt must be a positive number.');
  }
  const shapeFactor = rule(rules, 'footprint_shape_factor');
  return {
    footprintSqFt,
    perimeterFt: 4 * Math.sqrt(footprintSqFt) * shapeFactor,
    shapeFactor,
    sideCount: 4,
  };
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Overpass `out geom` -> candidate polygons. Tolerant of junk. */
export function parseOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  return elements
    .map((el) => {
      const geom = el.geometry ?? el.bounds ?? null;
      if (!Array.isArray(geom)) return null;
      const coords = geom
        .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map((p) => ({ lat: p.lat, lon: p.lon }));
      if (coords.length < 4) return null;   // 3 corners + closing vertex
      return { id: el.id, type: el.type, tags: el.tags ?? {}, coords };
    })
    .filter(Boolean);
}

export function overpassQuery(lat, lon, radius = SEARCH_RADIUS_M) {
  return `[out:json][timeout:15];\n`
       + `way(around:${radius},${lat},${lon})["building"];\n`
       + `out geom;`;
}

/** Normalize an address for cache keys so casing and spacing do not miss. */
export function normalizeAddress(address) {
  return String(address ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

/** Browsers forbid scripts from setting User-Agent; they send their own. */
const IS_BROWSER = typeof window !== 'undefined';

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(IS_BROWSER ? {} : { 'User-Agent': USER_AGENT }),
        ...(opts.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    // AbortError's own message is "signal is aborted without reason", which is
    // meaningless to a homeowner. Say what actually happened.
    if (err?.name === 'AbortError') throw new Error('timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** US Census geocoder: public domain, no key, no quota, US only. */
export async function geocodeCensus(address, deps = {}) {
  const f = deps.fetchJson ?? fetchJson;
  const url = `${GEOCODER_CENSUS}?address=${encodeURIComponent(address)}`
            + `&${GEOCODER_CENSUS_PARAMS}`;
  const json = await f(url);
  const match = json?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;
  return {
    lat: Number(match.coordinates.y),
    lon: Number(match.coordinates.x),
    matchedAddress: match.matchedAddress ?? address,
    provider: 'census',
  };
}

/** Nominatim fallback. Rate limited to 1 req/sec; only ever called on submit. */
export async function geocodeNominatim(address, deps = {}) {
  const f = deps.fetchJson ?? fetchJson;
  const url = `${GEOCODER_NOMINATIM}?format=jsonv2&limit=1`
            + `&countrycodes=us&q=${encodeURIComponent(address)}`;
  const json = await f(url, {
    headers: { Referer: deps.referer ?? 'https://specialistroofing.com' },
  });
  const hit = Array.isArray(json) ? json[0] : null;
  if (!hit) return null;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    matchedAddress: hit.display_name ?? address,
    provider: 'nominatim',
  };
}

/**
 * Which geocoder to try first, and it depends on where we are running.
 *
 * MEASURED: the US Census geocoder returns NO `Access-Control-Allow-Origin`
 * header, so a browser blocks every response. It is unusable from the page,
 * however keyless and unlimited it is. Nominatim returns `*` and works.
 *
 *   Census     200 | access-control-allow-origin: null
 *   Nominatim  200 | access-control-allow-origin: "*"
 *
 * So the browser uses Nominatim only - calling Census there would burn a
 * request, throw a console error, and never succeed. Node (the probe script)
 * keeps Census first, where CORS does not apply and its unlimited quota is
 * exactly what bulk probing wants, sparing the volunteer-funded service.
 */
export function geocoderChain(deps = {}) {
  if (deps.chain) return deps.chain;
  return IS_BROWSER
    ? [geocodeNominatim]
    : [geocodeCensus, geocodeNominatim];
}

export async function geocode(address, deps = {}) {
  for (const provider of geocoderChain(deps)) {
    try {
      const hit = await provider(address, deps);
      if (hit) return hit;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Ask Overpass for building ways near the point. Tries the mirror once. */
export async function fetchFootprints(lat, lon, deps = {}) {
  const f = deps.fetchJson ?? fetchJson;
  const body = `data=${encodeURIComponent(overpassQuery(lat, lon, deps.radius))}`;
  const post = {
    method: 'POST',
    body,
    timeout: deps.timeout ?? OVERPASS_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  };

  for (const endpoint of [OVERPASS, OVERPASS_MIRROR]) {
    try {
      return parseOverpass(await f(endpoint, post));
    } catch (err) {
      if (endpoint === OVERPASS_MIRROR) throw err;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

function cacheGet(key, deps) {
  const store = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function cacheSet(key, value, deps) {
  const store = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  try { store.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* full */ }
}

// ---------------------------------------------------------------------------
// the measurement chain
// ---------------------------------------------------------------------------

/**
 * Method A, OSM footprint. Runs geocode -> Overpass -> perimeter and stops at
 * the first failure, returning a result that says WHY rather than throwing.
 * The caller falls through to Method B (square footage) or C (manual).
 *
 * @returns {Promise<object>} always an object; check `.ok`
 */
export async function measureAddress(address, opts = {}) {
  const { rules = {}, deps = {}, useCache = true } = opts;
  const key = normalizeAddress(address);
  if (!key) return { ok: false, method: null, reason: 'no address supplied' };

  if (useCache) {
    const hit = cacheGet(key, deps);
    if (hit) return { ...hit, cached: true };
  }

  let point;
  try {
    point = await geocode(address, deps);
  } catch {
    point = null;
  }
  if (!point) {
    return {
      ok: false, method: null,
      reason: 'We could not find that address on the map.',
    };
  }

  // Widen the search only if the tight radius finds nothing.
  //
  // Both geocoders return a STREET-FRONT point, not a rooftop point - measured
  // at 76-97 ft from the nearest building centroid on real addresses - so a
  // house on a deep lot falls outside a 30 m circle entirely. Starting tight
  // keeps neighbours out of the candidate list when the building is close;
  // widening rescues the setbacks. See README "What phase 4 measured".
  let candidates = [];
  let searchRadiusM = null;
  try {
    // An ERROR exits the loop (throwing to the catch below) rather than
    // retrying at a wider radius: if Overpass is down, a bigger query will not
    // help and hammering it is exactly what the etiquette rules forbid. Only a
    // successful-but-empty answer widens the search.
    for (const radius of deps.radii ?? SEARCH_RADII_M) {
      candidates = await fetchFootprints(point.lat, point.lon, { ...deps, radius });
      searchRadiusM = radius;
      if (candidates.length) break;
    }
  } catch (err) {
    return {
      ok: false, method: null, point,
      reason: err.message === 'timed out'
        ? 'The public building-outline service is busy right now.'
        : `We could not reach the building-outline service (${err.message}).`,
    };
  }

  if (!candidates.length) {
    return {
      ok: false, method: null, point,
      reason: 'There is no building outline on file for that address yet.',
    };
  }

  const { chosen, ranked, reason } = chooseBuilding(candidates, point);
  const perimeterFt = polygonPerimeterFt(chosen.coords);
  const corners = countVertices(chosen.coords);

  const result = {
    ok: true,
    method: 'osm',
    // Honest grading, from what the probe actually found. The geocoded point
    // is almost never inside the polygon, so "contains-point" is rare and
    // nearest-centroid does the real work. When several buildings are in
    // range, the pick is a guess and the customer has to confirm it.
    confidence: gradeConfidence(reason, candidates.length),
    lfSource: 'osm',
    point,
    perimeterFt,
    corners,
    sideCount: corners,
    searchRadiusM,
    chosenDistanceFt: chosen.centroidDistanceFt,
    needsConfirmation: candidates.length > 1 || reason === 'nearest-centroid',
    sides: sideLengthsFt(chosen.coords),
    coords: chosen.coords,
    osmId: chosen.id,
    selection: reason,
    candidateCount: candidates.length,
    // Keep the alternatives so the UI can offer "not this one?" when several
    // buildings sit close together.
    alternatives: ranked.slice(1, 5).map((c) => ({
      id: c.id,
      coords: c.coords,
      perimeterFt: polygonPerimeterFt(c.coords),
      centroidDistanceFt: c.centroidDistanceFt,
    })),
  };

  if (useCache) cacheSet(key, result, deps);
  return result;
}

/**
 * The full chain: Method A, then B, then C. Returns the gutter footage plus
 * everything that went into it, so the UI can show its work and let the
 * customer override any step.
 *
 * @param {object} input
 * @param {string} [input.address]
 * @param {string} [input.roofType]   gable | hip | flat | unknown
 * @param {number} [input.totalSqFt]  Method B input
 * @param {number} [input.stories]    Method B input
 * @param {number} [input.manualLF]   Method C, always wins
 */
export async function resolveGutterLF(input, opts = {}) {
  const { rules = {} } = opts;
  const { address, roofType = 'unknown', totalSqFt, stories = 1, manualLF } = input;
  let methodAReason = null;

  // Method C: a number the customer typed always wins, and detaches the
  // figure from the calculation.
  if (Number.isFinite(manualLF) && manualLF > 0) {
    return {
      ok: true, method: 'manual', confidence: 'customer supplied',
      lfSource: 'manual', gutterLF: manualLF,
    };
  }

  // Method A
  if (address) {
    const measured = await measureAddress(address, opts);
    if (measured.ok) {
      const g = perimeterToGutterLF({
        perimeterFt: measured.perimeterFt,
        sideCount: measured.sideCount,
        roofType, rules,
      });
      return { ...measured, ...g, roofType };
    }
    // fall through to Method B, carrying the reason forward so the UI can
    // explain why the address did not produce a measurement.
    methodAReason = measured.reason;
  }

  // Method B
  if (Number.isFinite(totalSqFt) && totalSqFt > 0) {
    const b = sqftToPerimeterFt({ totalSqFt, stories, rules });
    const g = perimeterToGutterLF({
      perimeterFt: b.perimeterFt, sideCount: b.sideCount, roofType, rules,
    });
    return {
      ok: true, method: 'sqft', confidence: 'rough estimate', lfSource: 'sqft',
      ...b, ...g, roofType,
      fellBackBecause: methodAReason ?? null,
    };
  }

  return {
    ok: false, method: null,
    reason: methodAReason
      ?? 'need an address, a home square footage, or a linear feet figure',
  };
}
