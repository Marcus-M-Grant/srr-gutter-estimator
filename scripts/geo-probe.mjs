/**
 * Headless hit-rate probe for the address -> footprint -> perimeter chain.
 *
 * Phase 4 of the build exists to answer one question before any UI is built on
 * top of it: HOW OFTEN DOES OSM ACTUALLY HAVE THE BUILDING? This prints the
 * chain's result for each address and a hit rate at the end.
 *
 *   node scripts/geo-probe.mjs                      # built-in sample list
 *   node scripts/geo-probe.mjs addresses.txt        # one address per line
 *   node scripts/geo-probe.mjs --bbox               # residential coverage check
 *
 * Be polite: this hits the US Census geocoder and Overpass, both of which are
 * public goods. Requests are serialised with a delay between them, never run
 * in parallel, and never in a retry loop.
 */

import { readFileSync } from 'node:fs';
import { measureAddress, perimeterToGutterLF, polygonPerimeterFt } from '../src/geo.js';
import { buildConfig } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELAY_MS = 1200;   // Nominatim's policy is 1 req/sec; stay under it

/**
 * NOT SRR customer addresses. These are public civic and commercial buildings
 * in SRR's stated service area, used to smoke-test the pipeline.
 *
 * READ THE CAVEAT: civic buildings are far better mapped in OpenStreetMap than
 * ordinary houses, so the hit rate from this list is OPTIMISTIC and is not the
 * number to plan against. Replace it with ten real past gutter jobs
 * (`node scripts/geo-probe.mjs my-addresses.txt`) to get the real figure.
 */
const SAMPLE = [
  '1061 N Victory Pl, Burbank, CA 91502',
  '275 E Olive Ave, Burbank, CA 91502',
  '5031 Fair Ave, North Hollywood, CA 91601',
  '200 N Spring St, Los Angeles, CA 90012',
  '111 N Hope St, Los Angeles, CA 90012',
  '613 E Broadway, Glendale, CA 91206',
  '100 N Garfield Ave, Pasadena, CA 91101',
  '1685 Main St, Santa Monica, CA 90401',
  '411 W Ocean Blvd, Long Beach, CA 90802',
  '3031 Torrance Blvd, Torrance, CA 90503',
];

/**
 * Residential coverage sample. Small bounding boxes over ordinary residential
 * blocks: this is the honest read on whether OSM knows about houses, as
 * opposed to landmarks.
 */
const RESIDENTIAL_BOXES = [
  { name: 'Burbank, residential block',        s: 34.1750, w: -118.3300, n: 34.1790, e: -118.3240 },
  { name: 'North Hollywood, residential block', s: 34.1670, w: -118.3760, n: 34.1710, e: -118.3700 },
  { name: 'Glendale, residential block',        s: 34.1480, w: -118.2620, n: 34.1520, e: -118.2560 },
  { name: 'Pasadena, residential block',        s: 34.1400, w: -118.1400, n: 34.1440, e: -118.1340 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (n, d = 0) => Number(n).toFixed(d);

function loadRules() {
  const config = buildConfig(
    readFileSync(join(ROOT, 'data', 'pricing.csv'), 'utf8'),
    readFileSync(join(ROOT, 'data', 'rules.csv'), 'utf8'),
    'probe');
  return config.rules;
}

/** Node has no localStorage; disable the cache so the probe measures reality. */
const deps = { storage: null };

async function probeAddresses(addresses, rules) {
  console.log('='.repeat(78));
  console.log('ADDRESS -> BUILDING FOOTPRINT -> GUTTER FEET');
  console.log('='.repeat(78));
  console.log(
    pad('ADDRESS', 40) + pad('PERIM', 7) + pad('CNRS', 5) +
    pad('GABLE LF', 9) + pad('R', 4) + pad('DIST', 7) + 'CONFIDENCE');
  console.log('-'.repeat(78));

  const results = [];

  for (const address of addresses) {
    let r;
    try {
      r = await measureAddress(address, { rules, deps, useCache: false });
    } catch (err) {
      r = { ok: false, reason: `threw: ${err.message}` };
    }

    if (r.ok) {
      const { gutterLF } = perimeterToGutterLF({
        perimeterFt: r.perimeterFt, sideCount: r.sideCount,
        roofType: 'gable', rules,
      });
      const note = `${r.confidence}` +
        (r.candidateCount > 1 ? ` (${r.candidateCount} nearby)` : '');
      console.log(
        pad(address, 40) + pad(num(r.perimeterFt), 7) + pad(r.corners, 5) +
        pad(num(gutterLF), 9) + pad(`${r.searchRadiusM}m`, 4) +
        pad(`${num(r.chosenDistanceFt)}ft`, 7) + note);
      results.push({ address, ok: true, ...r, gutterLF });
    } else {
      console.log(
        pad(address, 40) + pad('-', 7) + pad('-', 5) +
        pad('-', 9) + pad('-', 4) + pad('-', 7) + `MISS: ${r.reason}`);
      results.push({ address, ok: false, reason: r.reason });
    }

    await sleep(DELAY_MS);
  }

  const hits = results.filter((r) => r.ok);
  console.log('-'.repeat(78));
  console.log(`HIT RATE: ${hits.length}/${results.length} ` +
              `(${num((hits.length / results.length) * 100, 0)}%)`);

  if (hits.length) {
    const perims = hits.map((h) => h.perimeterFt).sort((a, b) => a - b);
    const median = perims[Math.floor(perims.length / 2)];
    console.log(`Perimeters: min ${num(perims[0])} ft, ` +
                `median ${num(median)} ft, max ${num(perims[perims.length - 1])} ft`);

    const multi = hits.filter((h) => h.candidateCount > 1).length;
    const nearest = hits.filter((h) => h.selection === 'nearest-centroid').length;
    const widened = hits.filter((h) => h.searchRadiusM > 30).length;
    const dists = hits.map((h) => h.chosenDistanceFt).sort((a, b) => a - b);
    console.log(`Geocoded point sits ${num(dists[0])}-${num(dists[dists.length - 1])} ft ` +
                `from the chosen building's centre (median ${num(dists[Math.floor(dists.length / 2)])} ft).`);
    if (widened) {
      console.log(`${widened}/${hits.length} needed the wider 60 m search.`);
    }
    console.log(`${multi}/${hits.length} had more than one nearby building ` +
                `(the customer would be asked to confirm).`);
    if (nearest) {
      console.log(`${nearest}/${hits.length} fell back to NEAREST CENTROID - ` +
                  'the geocoded point was not inside any building.');
    }
  }

  const misses = results.filter((r) => !r.ok);
  if (misses.length) {
    console.log('\nMisses (these would use the square-footage fallback):');
    for (const m of misses) console.log(`  ${m.address}\n    ${m.reason}`);
  }

  return results;
}

/** How many buildings does OSM know about over an ordinary residential block? */
async function probeResidential() {
  const { OVERPASS } = await import('../src/providers.js');
  console.log('\n' + '='.repeat(78));
  console.log('RESIDENTIAL COVERAGE: buildings OSM has over ordinary blocks');
  console.log('='.repeat(78));
  console.log(pad('AREA', 36) + pad('BUILDINGS', 11) + pad('WITH GEOM', 11) + 'MEDIAN PERIM');
  console.log('-'.repeat(78));

  for (const box of RESIDENTIAL_BOXES) {
    const query = `[out:json][timeout:25];\n`
                + `way(${box.s},${box.w},${box.n},${box.e})["building"];\nout geom;`;
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ways = json.elements ?? [];
      const withGeom = ways.filter((w) => Array.isArray(w.geometry) && w.geometry.length >= 4);
      const perims = withGeom
        .map((w) => polygonPerimeterFt(w.geometry.map((p) => ({ lat: p.lat, lon: p.lon }))))
        .filter((p) => p > 40)
        .sort((a, b) => a - b);
      const median = perims.length ? perims[Math.floor(perims.length / 2)] : 0;
      console.log(pad(box.name, 36) + pad(ways.length, 11) +
                  pad(withGeom.length, 11) + (median ? `${num(median)} ft` : '-'));
    } catch (err) {
      console.log(pad(box.name, 36) + `FAILED: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log('-'.repeat(78));
  console.log('A residential block with only a handful of buildings means OSM');
  console.log('coverage is thin there and Method B will carry most of the load.');
}

async function main() {
  const arg = process.argv[2];
  const rules = loadRules();

  console.log(`Roof factors in use: gable ${rules.gutter_factor_gable}, ` +
              `hip ${rules.gutter_factor_hip}, flat ${rules.gutter_factor_flat}, ` +
              `unknown ${rules.gutter_factor_unknown}; ` +
              `overhang ${rules.overhang_allowance_ft} ft/side\n`);

  if (arg === '--bbox') {
    await probeResidential();
    return;
  }

  let addresses = SAMPLE;
  let usingSample = true;
  if (arg && !arg.startsWith('--')) {
    addresses = readFileSync(arg, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    usingSample = false;
  }

  await probeAddresses(addresses, rules);

  if (usingSample) {
    console.log('\n' + '!'.repeat(78));
    console.log('These are PUBLIC CIVIC BUILDINGS, not SRR jobs. Civic buildings are');
    console.log('much better mapped in OSM than houses, so this hit rate is');
    console.log('OPTIMISTIC. Re-run with ten real past gutter jobs for the real');
    console.log('number:  node scripts/geo-probe.mjs my-addresses.txt');
    console.log('!'.repeat(78));
  }
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
