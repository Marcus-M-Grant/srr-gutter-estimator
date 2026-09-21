/**
 * Pricing engine tests.
 *
 * Every expected number in here is hand computed and written out longhand in a
 * comment. None of it is snapshotted from whatever the code happened to
 * produce - a snapshot test of a pricing engine just freezes the bug.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildConfig } from '../src/config.js';
import { estimate, profileSize, findGuard, availableProfiles } from '../src/estimator.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The real committed snapshot. These tests are about real SRR prices. */
function loadRealConfig() {
  return buildConfig(
    readFileSync(join(ROOT, 'data', 'pricing.csv'), 'utf8'),
    readFileSync(join(ROOT, 'data', 'rules.csv'), 'utf8'),
    'test'
  );
}

/** Same config with some rules overridden, for the knob tests. */
function withRules(overrides) {
  const config = loadRealConfig();
  return { ...config, rules: { ...config.rules, ...overrides } };
}

const lineFor = (result, code) => result.lines.find((l) => l.code === code);

// ---------------------------------------------------------------------------

test('config snapshot loads without errors', () => {
  const config = loadRealConfig();
  assert.deepEqual(config.errors, [], 'snapshot must be valid');
  assert.ok(config.pricing.length > 0);
});

test('1. worked example: 5031 Fair Avenue, 200 LF, 2 storey, aluminium K Style 5"', () => {
  const config = loadRealConfig();
  const r = estimate(config, {
    measuredLF: 200,
    lfSource: 'manual',
    stories: 2,
    material: 'Aluminum',
    profile: 'K Style 5"',
    guards: false,
    runs: 1,
    corners: 4,
  });

  // billable = ceil(200 * 1.10) = 220
  assert.equal(r.quantities.billableLF, 220);
  // downspouts = max(2, ceil(200 / 35)) = max(2, ceil(5.714) = 6) = 6
  assert.equal(r.quantities.downspoutCount, 6);
  // downspout LF = 6 * 2 storeys * 10 ft = 120
  assert.equal(r.quantities.downspoutLF, 120);

  // Gutter line: 220 LF at $16.36 = $3,599.20
  const gutter = lineFor(r, 'Gutter Alum K Style 5"');
  assert.ok(gutter, 'gutter line must be priced');
  assert.equal(gutter.qty, 220);
  assert.equal(gutter.uom, 'LF');
  assert.equal(gutter.unitPrice, 16.36);
  assert.equal(gutter.lineTotal, 3599.20);

  // Downspout: K Style is not Half Round, so the rectangular code.
  // 120 LF at $18.18 = $2,181.60
  const ds = lineFor(r, 'Gutter Alum Down3x4 Smooth');
  assert.ok(ds, 'downspout line must be priced');
  assert.equal(ds.lineTotal, 2181.60);

  // Subtotal = 3599.20 + 2181.60 = 5780.80  (everything else is TBD/inactive)
  assert.equal(r.subtotal, 5780.80);

  // Above the 950 floor, so no minimum. Rounded up to the next 25:
  // ceil(5780.80 / 25) = ceil(231.232) = 232 -> 232 * 25 = 5800
  assert.equal(r.minimumApplied, false);
  assert.equal(r.total, 5800);

  // Band at +/- 10%
  assert.equal(r.lowBand, 5220);
  assert.equal(r.highBand, 6380);
});

test('2. copper at the same inputs prices from the copper SKU and is much higher', () => {
  const config = loadRealConfig();
  const base = {
    measuredLF: 200, stories: 2, profile: 'K Style 5"',
    guards: false, runs: 1, corners: 4,
  };
  const alum = estimate(config, { ...base, material: 'Aluminum' });
  const copper = estimate(config, { ...base, material: 'Copper' });

  // Gutter: 220 LF at $54.55 = $12,001.00
  const cg = lineFor(copper, 'Gutter Cpr K Style 5"');
  assert.ok(cg, 'must resolve the copper gutter row');
  assert.equal(cg.unitPrice, 54.55);
  assert.equal(cg.lineTotal, 12001.00);

  // Downspout: 120 LF at $54.55 = $6,546.00
  const cds = lineFor(copper, 'Gutter Cpr Down3x4 Smooth X');
  assert.ok(cds, 'must resolve the copper downspout row');
  assert.equal(cds.lineTotal, 6546.00);

  // Subtotal 12001.00 + 6546.00 = 18547.00
  // ceil(18547 / 25) = ceil(741.88) = 742 -> 18550
  assert.equal(copper.subtotal, 18547.00);
  assert.equal(copper.total, 18550);

  assert.ok(copper.total > alum.total * 3,
    `copper (${copper.total}) should be far above aluminium (${alum.total})`);
  // No aluminium part leaked into a copper quote.
  assert.ok(!copper.lines.some((l) => /Alum/i.test(l.code)));
});

test('3. a small single storey job is lifted to minimum_job_price', () => {
  const config = loadRealConfig();

  // 12 LF: billable = ceil(12 * 1.1) = ceil(13.2) = 14 LF at 16.36 = 229.04
  // downspouts = max(2, ceil(12/35) = 1) = 2 -> 2 * 1 * 10 = 20 LF at 18.18 = 363.60
  // subtotal = 592.64, which is under the 950 floor.
  const r = estimate(config, {
    measuredLF: 12, stories: 1, material: 'Aluminum', profile: 'K Style 5"',
  });
  assert.equal(r.subtotal, 592.64);
  assert.equal(r.minimumApplied, true);
  assert.equal(r.total, 950); // 950 is already a clean multiple of 25

  // NOTE: the spec's worked case for this test (40 LF, single storey) does NOT
  // hit the floor against real pricing:
  //   44 LF * 16.36 = 719.84, plus 20 LF downspout * 18.18 = 363.60 -> 1083.44
  // which is above 950. Asserted here so the discrepancy is recorded rather
  // than quietly papered over.
  const spec = estimate(config, {
    measuredLF: 40, stories: 1, material: 'Aluminum', profile: 'K Style 5"',
  });
  assert.equal(spec.subtotal, 1083.44);
  assert.equal(spec.minimumApplied, false);
});

test('4. Half Round resolves the round downspout, not the rectangular one', () => {
  const config = loadRealConfig();
  const r = estimate(config, {
    measuredLF: 200, stories: 1, material: 'Aluminum', profile: 'Half Round 6"',
  });

  assert.ok(lineFor(r, 'Gutter Alum Downspout 3" Round'), 'must use the round downspout');
  assert.equal(lineFor(r, 'Gutter Alum Down3x4 Smooth'), undefined,
    'must NOT use the rectangular downspout');

  // And the copper half round picks the copper round code.
  const c = estimate(config, {
    measuredLF: 200, stories: 1, material: 'Copper', profile: 'Half Round 6"',
  });
  assert.ok(lineFor(c, 'Gutter Cpr Down 3" Round'));
  assert.equal(lineFor(c, 'Gutter Cpr Down3x4 Smooth X'), undefined);
});

test('5. with all TBD- rows inactive the estimate still totals, and lists the gaps', () => {
  const config = loadRealConfig();
  const r = estimate(config, {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
    runs: 1, corners: 4,
  });

  assert.ok(r.total > 0, 'must still produce a total');
  assert.ok(r.unpriced.length > 0, 'must list the unpriced items');

  // Quantities are computed even though the parts are not priced.
  const elbows = r.unpriced.find((u) => u.code === 'TBD-Alum-Elbow');
  assert.ok(elbows, 'elbows must appear as unpriced, not silently vanish');
  assert.equal(elbows.qty, 18);            // 6 downspouts * 3 elbows
  assert.equal(r.quantities.hangerQty, 110); // ceil(220 * 0.5)
  assert.equal(r.quantities.strapQty, 24);   // 6 * 2 storeys * 2
  assert.equal(r.quantities.endCapQty, 2);   // 1 run * 2
  assert.equal(r.quantities.miterQty, 4);    // 4 corners

  // Nothing unpriced leaked into the priced lines or the subtotal.
  for (const u of r.unpriced) {
    assert.equal(lineFor(r, u.code), undefined, `${u.code} must not be billed`);
  }
  assert.equal(r.subtotal, 5780.80);
});

test('5b. pricing and activating a TBD row moves it into the total', () => {
  // Activating alone is not enough any more: the placeholder rows ship with no
  // Price at all, so a real cost has to be entered too. That mirrors what the
  // owner actually does in the sheet - fill in Unit Cost, then set Active.
  const config = loadRealConfig();
  const patched = {
    ...config,
    pricing: config.pricing.map((r) =>
      r.code === 'TBD-Alum-Hanger' ? { ...r, active: true, price: 7.27 } : r),
  };
  const r = estimate(patched, {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  });

  // 110 hangers at $7.27 = $799.70
  const hangers = lineFor(r, 'TBD-Alum-Hanger');
  assert.ok(hangers, 'an activated row must be billed');
  assert.equal(hangers.qty, 110);
  assert.equal(hangers.lineTotal, 799.70);
  assert.equal(r.subtotal, 5780.80 + 799.70);
  assert.ok(!r.unpriced.some((u) => u.code === 'TBD-Alum-Hanger'));
});

test('6. changing target_margin changes nothing - the engine reads Price only', () => {
  const base = loadRealConfig();
  const inputs = {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  };
  const before = estimate(base, inputs);

  // target_margin is stripped by config.js and never reaches the engine, so
  // even forcing it in must have no effect.
  const after = estimate(withRules({ target_margin: 0.9 }), inputs);

  assert.equal(after.total, before.total);
  assert.equal(after.subtotal, before.subtotal);
  assert.equal(base.rules.target_margin, undefined,
    'target_margin must never be loaded into the rules object');
});

test('7. rounding: a 4,412.03 subtotal with price_rounding 25 gives 4,425', () => {
  // Drive the subtotal to exactly 4412.03 with a one-line synthetic config so
  // the rounding rule is tested on its own.
  const config = {
    rules: {
      ...loadRealConfig().rules,
      waste_factor: 0,
      min_downspouts: 0,
      max_gutter_lf_per_downspout: 1e9,
      minimum_job_price: 0,
      price_rounding: 25,
      estimate_range_pct: 0.1,
      elbows_per_downspout: 0, straps_per_downspout_story: 0, hangers_per_lf: 0,
      end_caps_per_run: 0, splash_blocks_per_downspout: 0, sealant_units_per_job: 0,
    },
    pricing: [{
      code: 'TEST-GUTTER', name: 'Test gutter', description: 'Test',
      material: 'Aluminum', category: 'Gutter', profile: 'K Style 5"',
      uom: 'LF', price: 4412.03, active: true, costOfSaleAccount: '',
      isPlaceholder: false,
    }],
  };

  const r = estimate(config, {
    measuredLF: 1, stories: 1, material: 'Aluminum', profile: 'K Style 5"',
    runs: 0, corners: 0,
  });

  assert.equal(r.subtotal, 4412.03);
  assert.equal(r.total, 4425); // ceil(4412.03 / 25) = 177 -> 4425
});

test('7b. a total already on the rounding increment is left alone', () => {
  const config = loadRealConfig();
  // Guards against float drift turning 5800 into 5825.
  const r = estimate(config, {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  });
  assert.equal(r.total % 25, 0);
  assert.equal(r.total, 5800);
});

test('guards are size matched to the gutter, and are optional', () => {
  const config = loadRealConfig();

  assert.equal(profileSize('K Style 5"'), 5);
  assert.equal(profileSize('Half Round 6"'), 6);
  assert.equal(profileSize('No size here'), null);

  assert.equal(findGuard(config.pricing, 'Aluminum', 'K Style 5"').code, 'Gutter Alum Cover 5"');
  assert.equal(findGuard(config.pricing, 'Aluminum', 'Half Round 6"').code, 'Gutter Alum Cover 6"');
  // There is no copper cover in the sheet, so a copper job falls back to the
  // aluminium one of the right size rather than quoting no guards at all.
  assert.equal(findGuard(config.pricing, 'Copper', 'K Style 6"').code, 'Gutter Alum Cover 6"');

  const off = estimate(config, {
    measuredLF: 200, stories: 1, material: 'Aluminum', profile: 'K Style 5"', guards: false,
  });
  const on = estimate(config, {
    measuredLF: 200, stories: 1, material: 'Aluminum', profile: 'K Style 5"', guards: true,
  });

  assert.equal(off.quantities.guardLF, 0);
  assert.equal(on.quantities.guardLF, 220);
  // 220 LF at $14.55 = $3,201.00
  assert.equal(lineFor(on, 'Gutter Alum Cover 5"').lineTotal, 3201.00);
  assert.equal(on.subtotal, off.subtotal + 3201.00);
});

test('no cost or margin data can reach the result object', () => {
  const config = loadRealConfig();
  const r = estimate(config, {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"', guards: true,
  });
  const dump = JSON.stringify(r).toLowerCase();
  for (const forbidden of ['unitcost', 'unit cost', 'target_margin', 'margin']) {
    assert.ok(!dump.includes(forbidden), `result must not contain "${forbidden}"`);
  }
});

test('every rule the engine uses comes from config, never a literal', () => {
  const config = loadRealConfig();
  const inputs = {
    measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  };
  const base = estimate(config, inputs);

  // Doubling the waste factor must move billable LF.
  const wasteful = estimate(withRules({ waste_factor: 0.2 }), inputs);
  assert.equal(base.quantities.billableLF, 220);   // ceil(200 * 1.1)
  assert.equal(wasteful.quantities.billableLF, 240); // ceil(200 * 1.2)

  // Tightening the downspout rule must add downspouts.
  const tight = estimate(withRules({ max_gutter_lf_per_downspout: 20 }), inputs);
  assert.equal(tight.quantities.downspoutCount, 10); // ceil(200 / 20)

  // Rounding to the nearest 100 instead of 25.
  const coarse = estimate(withRules({ price_rounding: 100 }), inputs);
  assert.equal(coarse.total, 5800); // ceil(5780.80 / 100) = 58 -> 5800

  // A floor above the subtotal must bind.
  const floored = estimate(withRules({ minimum_job_price: 9000 }), inputs);
  assert.equal(floored.minimumApplied, true);
  assert.equal(floored.total, 9000);
});

test('bad inputs are rejected rather than quoted', () => {
  const config = loadRealConfig();
  const ok = { measuredLF: 100, material: 'Aluminum', profile: 'K Style 5"' };

  assert.throws(() => estimate(config, { ...ok, measuredLF: 0 }), /positive number/);
  assert.throws(() => estimate(config, { ...ok, measuredLF: -5 }), /positive number/);
  assert.throws(() => estimate(config, { ...ok, measuredLF: NaN }), /positive number/);
  assert.throws(() => estimate(config, { ...ok, material: '' }), /required/);
});

test('an unresolvable SKU is recorded, never substituted', () => {
  const config = loadRealConfig();
  // A profile that does not exist for this material.
  const r = estimate(config, {
    measuredLF: 100, stories: 1, material: 'Aluminum', profile: 'Nonexistent 9"',
  });
  assert.equal(r.lines.some((l) => l.code.includes('K Style')), false,
    'must not silently swap in a different gutter');
  assert.ok(r.unpriced.some((u) => /Gutter - Aluminum Nonexistent/.test(u.name)));
});

test('dropdowns are built from the sheet, not hardcoded', () => {
  const config = loadRealConfig();
  const alum = availableProfiles(config.pricing, 'Aluminum');
  assert.ok(alum.includes('K Style 5"'));
  assert.ok(alum.includes('Half Round 6"'));
  assert.ok(alum.includes(config.rules.default_gutter_profile),
    'the default profile rule must name a profile that actually exists');
});

test('a blank or zero price is treated as absent, never as free', () => {
  // The TBD- placeholder rows ship with no Price at all, because inventing one
  // would put a fabricated figure on a customer's estimate. A missing price
  // must surface as unpriced rather than quietly billing the line at $0.00.
  const config = loadRealConfig();

  for (const price of [NaN, 0, -5]) {
    const patched = {
      ...config,
      pricing: config.pricing.map((r) =>
        r.code === 'TBD-Alum-Hanger' ? { ...r, active: true, price } : r),
    };
    const r = estimate(patched, {
      measuredLF: 200, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
    });

    assert.equal(lineFor(r, 'TBD-Alum-Hanger'), undefined,
      `price ${price} must not be billed`);
    const listed = r.unpriced.find((u) => u.code === 'TBD-Alum-Hanger');
    assert.ok(listed, `price ${price} must be listed as unpriced`);
    assert.equal(listed.qty, 110);
    assert.equal(r.subtotal, 5780.80, 'the total must be unchanged');
  }
});

test('the shipped snapshot carries no invented placeholder prices', () => {
  const config = loadRealConfig();
  const placeholders = config.pricing.filter((r) => r.isPlaceholder);
  assert.equal(placeholders.length, 13);
  for (const p of placeholders) {
    assert.ok(!Number.isFinite(p.price),
      `${p.code} must ship with no price, got ${p.price}`);
  }
});

test('an unmatched item reports its real unit, not a default of EA', () => {
  // With the TBD- rows deleted from the sheet entirely, nothing matches the
  // accessory families any more. The quantities are still computed, and the
  // units have to stay honest: tear off is linear feet, and reporting
  // "368 EA" would describe a completely different job.
  const config = loadRealConfig();
  const stripped = {
    ...config,
    pricing: config.pricing.filter((r) => !r.isPlaceholder),
  };
  const r = estimate(stripped, {
    measuredLF: 334, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  });

  const byName = (n) => r.unpriced.find((u) => u.name === n);
  assert.equal(byName('Tear off and haul away').uom, 'LF');
  assert.equal(byName('Hidden hangers').uom, 'EA');
  assert.equal(byName('Elbows').uom, 'EA');
  for (const u of r.unpriced) {
    assert.ok(u.uom, `${u.name} must report a unit`);
  }
});
