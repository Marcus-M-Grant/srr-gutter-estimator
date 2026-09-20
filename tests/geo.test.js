/**
 * Geometry and measurement-chain tests.
 *
 * NO NETWORK. Every Overpass and geocoder response here is a fixture, injected
 * through the `deps.fetchJson` seam. That keeps the suite fast, deterministic,
 * and polite to two volunteer-funded services.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineFt, polygonPerimeterFt, openRing, countVertices, sideLengthsFt,
  polygonCentroid, pointInPolygon, chooseBuilding, roofFactorFor,
  perimeterToGutterLF, sqftToPerimeterFt, parseOverpass, overpassQuery,
  normalizeAddress, measureAddress, resolveGutterLF, GEO_DEFAULTS,
  gradeConfidence, geocoderChain, geocodeCensus, geocodeNominatim, geocode,
  deriveGutterRun,
} from '../src/geo.js';

/** The real rule values, as they sit on the Rules tab. */
const RULES = { ...GEO_DEFAULTS };

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Latitude of Burbank, so the longitude scaling is realistic. */
const LAT0 = 34.1808;
const LON0 = -118.3090;

const FT_PER_DEG_LAT = 364000;   // close enough for fixture construction

/** Build a lat/lon rectangle of a given size in feet, anchored at LAT0/LON0. */
function rectangle(widthFt, heightFt, originLat = LAT0, originLon = LON0) {
  const dLat = heightFt / FT_PER_DEG_LAT;
  const dLon = widthFt / (FT_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180));
  const ring = [
    { lat: originLat, lon: originLon },
    { lat: originLat, lon: originLon + dLon },
    { lat: originLat + dLat, lon: originLon + dLon },
    { lat: originLat + dLat, lon: originLon },
  ];
  return [...ring, ring[0]];   // closed, as OSM returns it
}

const overpassResponse = (polygons) => ({
  version: 0.6,
  elements: polygons.map((coords, i) => ({
    type: 'way',
    id: 1000 + i,
    geometry: coords.map((p) => ({ lat: p.lat, lon: p.lon })),
    tags: { building: 'yes' },
  })),
});

/** A fetchJson stand-in that answers the geocoder then Overpass. */
function stubDeps({ geocode: geo, overpass, overpassError }) {
  return {
    storage: null,   // no caching in tests
    fetchJson: async (url) => {
      if (url.includes('census.gov')) {
        if (!geo) throw new Error('census down');
        return { result: { addressMatches: [{
          coordinates: { x: geo.lon, y: geo.lat },
          matchedAddress: geo.matchedAddress ?? 'MATCHED',
        }] } };
      }
      if (url.includes('nominatim')) {
        if (!geo) return [];
        return [{ lat: String(geo.lat), lon: String(geo.lon), display_name: 'NOMINATIM' }];
      }
      if (url.includes('overpass')) {
        if (overpassError) throw new Error(overpassError);
        return overpassResponse(overpass ?? []);
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 8. perimeter maths
// ---------------------------------------------------------------------------

test('8. a 50 x 50 ft square returns a 200 ft perimeter, within a foot', () => {
  const square = rectangle(50, 50);
  const perimeter = polygonPerimeterFt(square);
  assert.ok(Math.abs(perimeter - 200) < 1,
    `expected ~200 ft, got ${perimeter.toFixed(3)}`);
});

test('the closing vertex is dropped, not counted twice', () => {
  const closed = rectangle(50, 50);
  const open = closed.slice(0, -1);

  assert.equal(closed.length, 5);
  assert.equal(openRing(closed).length, 4);
  assert.equal(countVertices(closed), 4, 'a rectangle has 4 corners, not 5');

  // Perimeter must be identical whether or not the ring was closed.
  assert.ok(Math.abs(polygonPerimeterFt(closed) - polygonPerimeterFt(open)) < 1e-9);
});

test('haversine is symmetric and zero for identical points', () => {
  const a = { lat: LAT0, lon: LON0 };
  const b = { lat: LAT0 + 0.001, lon: LON0 + 0.001 };
  assert.equal(haversineFt(a, a), 0);
  assert.ok(Math.abs(haversineFt(a, b) - haversineFt(b, a)) < 1e-9);
});

test('side lengths add up to the perimeter and name every wall', () => {
  const rect = rectangle(60, 40);
  const sides = sideLengthsFt(rect);
  assert.equal(sides.length, 4);
  const total = sides.reduce((s, x) => s + x.lengthFt, 0);
  assert.ok(Math.abs(total - polygonPerimeterFt(rect)) < 1e-9);
  // 60 x 40 -> two sides near 60, two near 40
  const lengths = sides.map((s) => Math.round(s.lengthFt)).sort((a, b) => a - b);
  assert.deepEqual(lengths, [40, 40, 60, 60]);
});

test('a degenerate polygon measures zero rather than throwing', () => {
  assert.equal(polygonPerimeterFt([]), 0);
  assert.equal(polygonPerimeterFt([{ lat: 1, lon: 1 }]), 0);
  assert.equal(polygonPerimeterFt([{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }]), 0);
  assert.deepEqual(sideLengthsFt([]), []);
});

// ---------------------------------------------------------------------------
// 9. perimeter is not gutter footage
// ---------------------------------------------------------------------------

test('9. 200 ft perimeter, gable, 4 sides -> 200 * 0.62 + 4 * 1.0 = 128 LF', () => {
  const { gutterLF, roofFactor } = perimeterToGutterLF({
    perimeterFt: 200, sideCount: 4, roofType: 'gable', rules: RULES,
  });
  assert.equal(roofFactor, 0.62);
  assert.equal(gutterLF, 128);
});

test('every roof type applies its own factor, and "not sure" is the unknown one', () => {
  const at = (roofType) => perimeterToGutterLF({
    perimeterFt: 200, sideCount: 4, roofType, rules: RULES,
  });

  assert.equal(at('gable').gutterLF, 128);     // 200 * 0.62 + 4
  assert.equal(at('hip').gutterLF, 204);       // 200 * 1.00 + 4
  assert.equal(at('flat').gutterLF, 194);      // 200 * 0.95 + 4
  assert.equal(at('unknown').gutterLF, 164);   // 200 * 0.80 + 4
  assert.equal(at(undefined).gutterLF, 164, 'no answer falls to unknown');
  assert.equal(at('NOT A ROOF').gutterLF, 164, 'junk falls to unknown');
  assert.equal(at('Gable').gutterLF, 128, 'case insensitive');

  // A hip roof gets gutter on all four sides, a gable on roughly two: the
  // whole point of the correction.
  assert.ok(at('hip').gutterLF > at('gable').gutterLF * 1.5);
});

test('roof factors come from the rules, never from a literal', () => {
  const custom = { ...RULES, gutter_factor_gable: 0.5, overhang_allowance_ft: 2 };
  const { gutterLF } = perimeterToGutterLF({
    perimeterFt: 200, sideCount: 4, roofType: 'gable', rules: custom,
  });
  assert.equal(gutterLF, 108);   // 200 * 0.5 + 4 * 2
  assert.equal(roofFactorFor('gable', custom), 0.5);
});

test('a missing rule falls back to the documented default', () => {
  assert.equal(roofFactorFor('gable', {}), 0.62);
  assert.equal(roofFactorFor('gable', { gutter_factor_gable: NaN }), 0.62);
});

// ---------------------------------------------------------------------------
// 10. square footage fallback
// ---------------------------------------------------------------------------

test('10. 2,400 sq ft over 2 stories -> 4 * sqrt(1200) * 1.12, about 155 ft', () => {
  const { perimeterFt, footprintSqFt } = sqftToPerimeterFt({
    totalSqFt: 2400, stories: 2, rules: RULES,
  });
  assert.equal(footprintSqFt, 1200);
  const expected = 4 * Math.sqrt(1200) * 1.12;   // 155.13...
  assert.ok(Math.abs(perimeterFt - expected) < 1e-9);
  assert.ok(Math.abs(perimeterFt - 155) < 1, `expected ~155, got ${perimeterFt.toFixed(2)}`);
});

test('single storey uses the whole square footage as the footprint', () => {
  const { footprintSqFt } = sqftToPerimeterFt({ totalSqFt: 1200, stories: 1, rules: RULES });
  assert.equal(footprintSqFt, 1200);
});

test('the shape factor is what separates a real house from a perfect square', () => {
  const square = sqftToPerimeterFt({
    totalSqFt: 1200, stories: 1, rules: { ...RULES, footprint_shape_factor: 1 },
  });
  assert.ok(Math.abs(square.perimeterFt - 4 * Math.sqrt(1200)) < 1e-9);
});

test('bad square footage is rejected rather than quoted', () => {
  for (const bad of [0, -100, NaN, 'abc', undefined]) {
    assert.throws(() => sqftToPerimeterFt({ totalSqFt: bad, stories: 1, rules: RULES }),
      /positive number/);
  }
});

// ---------------------------------------------------------------------------
// 11. picking the right building
// ---------------------------------------------------------------------------

test('11. with three candidates, the one containing the point wins', () => {
  // Three buildings side by side. The point sits inside the middle one, which
  // is deliberately NOT the one with the nearest centroid ordering by chance.
  const left = rectangle(40, 40, LAT0, LON0 - 0.0020);
  const middle = rectangle(40, 40, LAT0, LON0);
  const right = rectangle(40, 40, LAT0, LON0 + 0.0020);

  const point = polygonCentroid(middle);
  const candidates = [
    { id: 1, coords: left },
    { id: 2, coords: middle },
    { id: 3, coords: right },
  ];

  const { chosen, reason } = chooseBuilding(candidates, point);
  assert.equal(chosen.id, 2);
  assert.equal(reason, 'contains-point');
  assert.ok(pointInPolygon(point, middle));
  assert.ok(!pointInPolygon(point, left));
  assert.ok(!pointInPolygon(point, right));
});

test('when no polygon contains the point, the nearest centroid wins', () => {
  const near = rectangle(40, 40, LAT0 + 0.0002, LON0);
  const far = rectangle(40, 40, LAT0 + 0.0060, LON0);
  const point = { lat: LAT0 - 0.0001, lon: LON0 + 0.0001 };

  const { chosen, reason, ranked } = chooseBuilding(
    [{ id: 'far', coords: far }, { id: 'near', coords: near }], point);

  assert.equal(chosen.id, 'near');
  assert.equal(reason, 'nearest-centroid');
  assert.equal(ranked[0].id, 'near', 'ranked list is ordered for the UI to offer');
  assert.equal(ranked.length, 2);
});

test('no candidates is reported, not crashed', () => {
  const { chosen, reason } = chooseBuilding([], { lat: LAT0, lon: LON0 });
  assert.equal(chosen, null);
  assert.equal(reason, 'none');
});

test('a point outside every polygon is correctly outside', () => {
  const rect = rectangle(40, 40);
  assert.ok(!pointInPolygon({ lat: LAT0 - 0.01, lon: LON0 }, rect));
  assert.ok(pointInPolygon(polygonCentroid(rect), rect));
});

// ---------------------------------------------------------------------------
// parsing and query construction
// ---------------------------------------------------------------------------

test('the Overpass query asks for building ways around the point', () => {
  const q = overpassQuery(34.1, -118.3);
  assert.match(q, /\[out:json\]\[timeout:15\]/);
  assert.match(q, /way\(around:30,34\.1,-118\.3\)\["building"\]/);
  assert.match(q, /out geom;/);
});

test('parseOverpass skips elements with no usable geometry', () => {
  const json = {
    elements: [
      { type: 'way', id: 1, geometry: rectangle(40, 40), tags: { building: 'house' } },
      { type: 'node', id: 2 },                                    // no geometry
      { type: 'way', id: 3, geometry: [{ lat: 1, lon: 1 }] },     // too few points
      { type: 'way', id: 4, geometry: [{ lat: null, lon: null }] },
    ],
  };
  const parsed = parseOverpass(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 1);
  assert.equal(parsed[0].tags.building, 'house');
});

test('parseOverpass tolerates junk rather than throwing', () => {
  for (const junk of [null, undefined, {}, { elements: null }, { elements: 'x' }]) {
    assert.deepEqual(parseOverpass(junk), []);
  }
});

test('addresses normalize so cache keys do not miss on spacing or case', () => {
  assert.equal(
    normalizeAddress('  5031   Fair Avenue, North HOLLYWOOD, CA  '),
    '5031 fair avenue, north hollywood, ca');
  assert.equal(normalizeAddress(null), '');
});

// ---------------------------------------------------------------------------
// 12. the chain falls through rather than throwing
// ---------------------------------------------------------------------------

test('12. an Overpass timeout falls through to Method B, it does not throw', async () => {
  const deps = stubDeps({
    geocode: { lat: LAT0, lon: LON0 },
    overpassError: 'The operation was aborted due to timeout',
  });

  const measured = await measureAddress('1 Somewhere St', { rules: RULES, deps });
  assert.equal(measured.ok, false);
  assert.match(measured.reason, /could not reach the building-outline service/i);

  const resolved = await resolveGutterLF(
    { address: '1 Somewhere St', roofType: 'gable', totalSqFt: 2400, stories: 2 },
    { rules: RULES, deps });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.method, 'sqft');
  assert.equal(resolved.confidence, 'rough estimate');
  assert.match(resolved.fellBackBecause, /could not reach the building-outline service/i);
  // 4*sqrt(1200)*1.12 = 155.13 -> * 0.62 + 4 = 100.18
  assert.ok(Math.abs(resolved.gutterLF - (4 * Math.sqrt(1200) * 1.12 * 0.62 + 4)) < 1e-9);
});

test('12b. an empty Overpass result also falls through to Method B', async () => {
  const deps = stubDeps({ geocode: { lat: LAT0, lon: LON0 }, overpass: [] });

  const measured = await measureAddress('2 Nowhere St', { rules: RULES, deps });
  assert.equal(measured.ok, false);
  assert.match(measured.reason, /no building outline on file/i);

  const resolved = await resolveGutterLF(
    { address: '2 Nowhere St', roofType: 'hip', totalSqFt: 1600, stories: 1 },
    { rules: RULES, deps });
  assert.equal(resolved.method, 'sqft');
  assert.equal(resolved.ok, true);
});

test('a failed geocode falls through too, and says so', async () => {
  const deps = stubDeps({ geocode: null });
  const measured = await measureAddress('not an address', { rules: RULES, deps });
  assert.equal(measured.ok, false);
  assert.match(measured.reason, /could not find that address/i);
});

test('with no address, no square footage and no manual figure, it says what it needs',
  async () => {
    const resolved = await resolveGutterLF({}, { rules: RULES, deps: stubDeps({}) });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /need an address/);
  });

// ---------------------------------------------------------------------------
// the happy path, end to end on fixtures
// ---------------------------------------------------------------------------

test('Method A measures the footprint and applies the roof factor', async () => {
  const building = rectangle(50, 50);
  const point = polygonCentroid(building);
  const deps = stubDeps({ geocode: point, overpass: [building] });

  const r = await resolveGutterLF(
    { address: '5031 Fair Avenue, North Hollywood, CA 91601', roofType: 'gable' },
    { rules: RULES, deps });

  assert.equal(r.ok, true);
  assert.equal(r.method, 'osm');
  assert.equal(r.confidence, 'high');
  assert.equal(r.lfSource, 'osm');
  assert.equal(r.corners, 4);
  assert.ok(Math.abs(r.perimeterFt - 200) < 1);
  // 200 * 0.62 + 4 * 1.0 = 128
  assert.ok(Math.abs(r.gutterLF - 128) < 1, `expected ~128, got ${r.gutterLF.toFixed(2)}`);
  assert.equal(r.roofFactor, 0.62);
  assert.equal(r.selection, 'contains-point');
  assert.equal(r.sides.length, 4);
});

test('a manual figure always wins, and is labelled customer supplied', async () => {
  const building = rectangle(50, 50);
  const deps = stubDeps({ geocode: polygonCentroid(building), overpass: [building] });

  const r = await resolveGutterLF(
    { address: '5031 Fair Avenue', roofType: 'gable', totalSqFt: 2400, manualLF: 193 },
    { rules: RULES, deps });

  assert.equal(r.method, 'manual');
  assert.equal(r.lfSource, 'manual');
  assert.equal(r.gutterLF, 193);
  assert.equal(r.confidence, 'customer supplied');
});

test('alternatives are returned so the customer can pick a different building',
  async () => {
    const mine = rectangle(40, 40, LAT0, LON0);
    const neighbour = rectangle(40, 40, LAT0, LON0 + 0.0006);
    const deps = stubDeps({
      geocode: polygonCentroid(mine), overpass: [mine, neighbour],
    });

    const r = await measureAddress('3 Close St', { rules: RULES, deps });
    assert.equal(r.ok, true);
    assert.equal(r.candidateCount, 2);
    assert.equal(r.alternatives.length, 1);
    assert.ok(r.alternatives[0].perimeterFt > 0);
  });

test('the geocoder falls back to Nominatim when Census is down', async () => {
  const building = rectangle(50, 50);
  const point = polygonCentroid(building);
  let censusCalled = false;

  const deps = {
    storage: null,
    fetchJson: async (url) => {
      if (url.includes('census.gov')) { censusCalled = true; throw new Error('502'); }
      if (url.includes('nominatim')) {
        return [{ lat: String(point.lat), lon: String(point.lon), display_name: 'NOM' }];
      }
      return overpassResponse([building]);
    },
  };

  const r = await measureAddress('4 Fallback Ave', { rules: RULES, deps });
  assert.ok(censusCalled, 'Census must be tried first');
  assert.equal(r.ok, true);
  assert.equal(r.point.provider, 'nominatim');
});

test('results are cached by normalized address, so a reload costs no requests',
  async () => {
    const building = rectangle(50, 50);
    const point = polygonCentroid(building);
    let calls = 0;

    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };
    const deps = {
      storage,
      fetchJson: async (url) => {
        calls++;
        if (url.includes('census.gov')) {
          return { result: { addressMatches: [{
            coordinates: { x: point.lon, y: point.lat }, matchedAddress: 'M' }] } };
        }
        return overpassResponse([building]);
      },
    };

    const first = await measureAddress('5031 Fair Avenue', { rules: RULES, deps });
    assert.equal(first.ok, true);
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst >= 2, 'first lookup hits geocoder and Overpass');

    // Different casing and spacing must still hit the cache.
    const second = await measureAddress('  5031   FAIR avenue ', { rules: RULES, deps });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls, callsAfterFirst, 'a cached address makes no new requests');
  });

test('a storage failure degrades to no caching rather than breaking', async () => {
  const building = rectangle(50, 50);
  const point = polygonCentroid(building);
  const storage = {
    getItem() { throw new Error('private mode'); },
    setItem() { throw new Error('quota exceeded'); },
  };
  const deps = {
    storage,
    fetchJson: async (url) => (url.includes('census.gov')
      ? { result: { addressMatches: [{ coordinates: { x: point.lon, y: point.lat } }] } }
      : overpassResponse([building])),
  };

  const r = await measureAddress('6 Private St', { rules: RULES, deps });
  assert.equal(r.ok, true, 'storage throwing must not break the measurement');
});

// ---------------------------------------------------------------------------
// what the phase 4 probe found against real addresses
// ---------------------------------------------------------------------------

test('confidence is graded honestly, because the point is rarely inside', () => {
  assert.equal(gradeConfidence('contains-point', 1), 'high');
  assert.equal(gradeConfidence('contains-point', 3), 'good');
  assert.equal(gradeConfidence('nearest-centroid', 1), 'likely');
  assert.equal(gradeConfidence('nearest-centroid', 4), 'needs confirmation');
});

test('a street-front geocode with neighbours is flagged for confirmation', async () => {
  // Reproduces what the probe saw on real addresses: the geocoded point sits
  // off the building (street frontage), and more than one building is in range.
  const mine = rectangle(40, 40, LAT0, LON0);
  const neighbour = rectangle(40, 40, LAT0, LON0 + 0.0006);
  const street = { lat: LAT0 - 0.00025, lon: LON0 + 0.0002 };   // ~90 ft away

  const deps = stubDeps({ geocode: street, overpass: [mine, neighbour] });
  const r = await measureAddress('7 Setback Rd', { rules: RULES, deps });

  assert.equal(r.ok, true);
  assert.equal(r.selection, 'nearest-centroid', 'the point is not inside any polygon');
  assert.equal(r.confidence, 'needs confirmation');
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.candidateCount, 2);
  assert.ok(r.chosenDistanceFt > 0, 'the real centroid distance is reported');
});

test('a lone building off the street point is "likely", not "high"', async () => {
  const mine = rectangle(40, 40, LAT0, LON0);
  const street = { lat: LAT0 - 0.00025, lon: LON0 + 0.0002 };
  const deps = stubDeps({ geocode: street, overpass: [mine] });

  const r = await measureAddress('8 Lone House Ln', { rules: RULES, deps });
  assert.equal(r.confidence, 'likely');
  assert.equal(r.needsConfirmation, true);
});

test('the search widens only when the tight radius finds nothing', async () => {
  // The probe found buildings 167 ft from the geocoded point that a 30 m
  // circle missed entirely. Record the radii actually requested.
  const building = rectangle(40, 40, LAT0 + 0.0004, LON0);
  const point = { lat: LAT0, lon: LON0 };
  const radiiTried = [];

  const deps = {
    storage: null,
    fetchJson: async (url, opts) => {
      if (url.includes('census.gov')) {
        return { result: { addressMatches: [{
          coordinates: { x: point.lon, y: point.lat } }] } };
      }
      const radius = Number(decodeURIComponent(opts.body).match(/around:(\d+)/)[1]);
      radiiTried.push(radius);
      // Only the wider search reaches this building.
      return overpassResponse(radius >= 60 ? [building] : []);
    },
  };

  const r = await measureAddress('9 Deep Lot Dr', { rules: RULES, deps });
  assert.deepEqual(radiiTried, [30, 60], 'tight first, then wider');
  assert.equal(r.ok, true);
  assert.equal(r.searchRadiusM, 60);
});

test('the tight radius is used alone when it already finds something', async () => {
  const building = rectangle(40, 40);
  const point = polygonCentroid(building);
  const radiiTried = [];

  const deps = {
    storage: null,
    fetchJson: async (url, opts) => {
      if (url.includes('census.gov')) {
        return { result: { addressMatches: [{
          coordinates: { x: point.lon, y: point.lat } }] } };
      }
      radiiTried.push(Number(decodeURIComponent(opts.body).match(/around:(\d+)/)[1]));
      return overpassResponse([building]);
    },
  };

  const r = await measureAddress('10 Close St', { rules: RULES, deps });
  assert.deepEqual(radiiTried, [30], 'must not widen unnecessarily');
  assert.equal(r.searchRadiusM, 30);
  assert.equal(r.confidence, 'high', 'point inside, single candidate');
});

test('the geocoder chain is environment aware, because Census has no CORS', () => {
  // Measured: Census replies 200 with NO access-control-allow-origin header,
  // so a browser blocks it outright. Under Node (these tests) it is fine and
  // is preferred, since its quota is unlimited and Nominatim's is not.
  const chain = geocoderChain();
  assert.equal(chain.length, 2, 'Node tries Census then Nominatim');
  assert.equal(chain[0], geocodeCensus);
  assert.equal(chain[1], geocodeNominatim);

  // An explicit chain overrides the default, which is how the browser path and
  // the tests pin the behaviour.
  const only = [geocodeNominatim];
  assert.deepEqual(geocoderChain({ chain: only }), only);
});

test('a browser-shaped chain never calls Census', async () => {
  const called = [];
  const deps = {
    storage: null,
    chain: [geocodeNominatim],
    fetchJson: async (url) => {
      called.push(url.includes('census.gov') ? 'census' : 'nominatim');
      if (url.includes('census.gov')) throw new Error('should never be called');
      return [{ lat: '34.18', lon: '-118.32', display_name: 'N' }];
    },
  };

  const hit = await geocode('1 Test St', deps);
  assert.equal(hit.provider, 'nominatim');
  assert.deepEqual(called, ['nominatim'], 'Census must not be attempted');
});

test('geocode returns null when every provider fails, it does not throw', async () => {
  const deps = {
    storage: null,
    chain: [geocodeCensus, geocodeNominatim],
    fetchJson: async () => { throw new Error('offline'); },
  };
  assert.equal(await geocode('1 Test St', deps), null);
});

// ---------------------------------------------------------------------------
// the editable chain (spec 6.5)
// ---------------------------------------------------------------------------

/** A 60 x 40 ft building: 200 ft perimeter, four walls. */
function measurementFixture() {
  const coords = rectangle(60, 40);
  return {
    ok: true, perimeterFt: polygonPerimeterFt(coords), corners: 4, sideCount: 4,
    sides: sideLengthsFt(coords), coords,
  };
}

test('untouched, the chain is perimeter x roof factor + overhang', () => {
  const r = deriveGutterRun({
    measurement: measurementFixture(), roofType: 'gable', rules: RULES,
  });
  assert.equal(r.source, 'outline');
  assert.equal(r.roofFactorApplies, true);
  assert.equal(r.roofFactor, 0.62);
  assert.equal(r.sideCount, 4);
  assert.ok(Math.abs(r.perimeterFt - 200) < 1);
  assert.ok(Math.abs(r.gutterLF - 128) < 1);   // 200 * 0.62 + 4
});

test('switching walls off replaces the roof factor rather than stacking with it',
  () => {
    const measurement = measurementFixture();

    // Turn off the two 60 ft walls: 80 ft of gutter across two walls remain.
    const long = measurement.sides
      .filter((s) => s.lengthFt > 50).map((s) => s.index);
    assert.equal(long.length, 2);

    const r = deriveGutterRun({
      measurement, roofType: 'gable', disabledSides: long, rules: RULES,
    });

    assert.equal(r.source, 'sides-selected');
    assert.equal(r.roofFactorApplies, false, 'the customer has answered directly');
    assert.equal(r.roofFactor, 1, 'so no second reduction is applied');
    assert.equal(r.sideCount, 2);
    assert.equal(r.disabledCount, 2);
    assert.ok(Math.abs(r.perimeterFt - 80) < 1);
    assert.ok(Math.abs(r.gutterLF - 82) < 1);   // 80 * 1.0 + 2 * 1.0

    // The bug this guards against: applying 0.62 on top would give ~51.6 ft,
    // roughly a third under, and quote the job far too cheap.
    assert.ok(r.gutterLF > 70, `must not double-count: got ${r.gutterLF}`);
  });

test('the roof type still applies while every wall is switched on', () => {
  const measurement = measurementFixture();
  const all = deriveGutterRun({
    measurement, roofType: 'hip', disabledSides: [], rules: RULES,
  });
  assert.equal(all.roofFactorApplies, true);
  assert.equal(all.roofFactor, 1.00);
  assert.ok(Math.abs(all.gutterLF - 204) < 1);
});

test('a typed perimeter overrides the outline and the wall list', () => {
  const measurement = measurementFixture();
  const r = deriveGutterRun({
    measurement, roofType: 'gable', perimeterOverride: 312,
    disabledSides: [0], rules: RULES,
  });
  assert.equal(r.source, 'perimeter-edited');
  assert.equal(r.perimeterFt, 312);
  assert.equal(r.sideCount, 4, 'the typed figure is a whole-building number');
  assert.equal(r.roofFactorApplies, true, 'the roof type still means something');
  assert.ok(Math.abs(r.gutterLF - (312 * 0.62 + 4)) < 1e-9);   // 197.44
});

test('switching every wall off gives zero, not a negative or a NaN', () => {
  const measurement = measurementFixture();
  const r = deriveGutterRun({
    measurement, roofType: 'gable', disabledSides: [0, 1, 2, 3], rules: RULES,
  });
  assert.equal(r.perimeterFt, 0);
  assert.equal(r.sideCount, 0);
  assert.equal(r.gutterLF, 0);
});

test('with no measurement at all the chain is zero, not a crash', () => {
  const r = deriveGutterRun({ rules: RULES });
  assert.equal(r.source, 'none');
  assert.equal(r.perimeterFt, 0);
  assert.equal(r.gutterLF, 4);   // overhang on an assumed 4 sides
});

test('the selected walls always sum to the stated perimeter', () => {
  const measurement = measurementFixture();
  for (const off of [[], [0], [1, 2], [0, 3]]) {
    const r = deriveGutterRun({ measurement, disabledSides: off, rules: RULES });
    const expected = measurement.sides
      .filter((s) => !off.includes(s.index))
      .reduce((sum, s) => sum + s.lengthFt, 0);
    if (off.length) {
      assert.ok(Math.abs(r.perimeterFt - expected) < 1e-9,
        `perimeter must equal the selected walls for off=[${off}]`);
      assert.equal(r.sideCount, 4 - off.length);
    }
  }
});
