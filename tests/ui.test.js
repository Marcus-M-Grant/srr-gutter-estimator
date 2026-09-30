/**
 * Address composition tests.
 *
 * The form collects street / city / state / ZIP separately, but the geocoder
 * and the statement of work both want one line. Getting the join wrong means
 * either a failed lookup or a malformed address printed on a contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fullAddress, addressIsUsable } from '../src/ui.js';

test('the four fields join into one line', () => {
  assert.equal(
    fullAddress({ addressLine: '5031 Fair Avenue', city: 'North Hollywood',
                  stateCode: 'CA', zip: '91601' }),
    '5031 Fair Avenue, North Hollywood, CA 91601');
});

test('state and ZIP share a segment, separated by a space not a comma', () => {
  const out = fullAddress({ addressLine: '1 A St', city: 'Burbank',
                            stateCode: 'CA', zip: '91502' });
  assert.ok(out.endsWith('CA 91502'));
  assert.ok(!out.includes('CA, 91502'));
});

test('blank fields are skipped rather than leaving stray commas', () => {
  assert.equal(fullAddress({ addressLine: '1 A St', city: '', stateCode: 'CA', zip: '' }),
    '1 A St, CA');
  assert.equal(fullAddress({ addressLine: '1 A St', city: 'Burbank', stateCode: '', zip: '' }),
    '1 A St, Burbank');
  assert.equal(fullAddress({ addressLine: '1 A St', city: '', stateCode: '', zip: '91502' }),
    '1 A St, 91502');
  assert.equal(fullAddress({}), '');
  for (const out of [fullAddress({ addressLine: '1 A St' })]) {
    assert.ok(!out.includes(', ,'), 'no empty segment');
    assert.ok(!out.endsWith(','), 'no trailing comma');
  }
});

test('whitespace is trimmed and the state is upper-cased', () => {
  assert.equal(
    fullAddress({ addressLine: '  1 A St  ', city: ' Burbank ',
                  stateCode: ' ca ', zip: ' 91502 ' }),
    '1 A St, Burbank, CA 91502');
});

test('a lookup needs a street plus either a city or a ZIP', () => {
  const street = { addressLine: '5031 Fair Avenue' };
  assert.equal(addressIsUsable({ ...street, city: 'North Hollywood' }), true);
  assert.equal(addressIsUsable({ ...street, zip: '91601' }), true);
  assert.equal(addressIsUsable({ ...street, city: '', zip: '' }), false,
    'a street alone is too vague to geocode');
  assert.equal(addressIsUsable({ city: 'North Hollywood', zip: '91601' }), false,
    'a city alone has no building to measure');
  assert.equal(addressIsUsable({}), false);
  assert.equal(addressIsUsable({ addressLine: '   ', city: 'Burbank' }), false);
});

// ---------------------------------------------------------------------------
// which materials a customer is offered
// ---------------------------------------------------------------------------

import { offeredMaterials } from '../src/ui.js';

const pricingWith = (...materials) => materials.map((m) => ({
  code: `${m}-K5`, name: `${m} K Style`, description: 'Gutter - K Style 5"',
  material: m, category: 'Gutter', profile: 'K Style 5"', uom: 'LF',
  price: 16.36, active: true, costOfSaleAccount: '', isPlaceholder: false,
}));

test('only aluminium is offered by default, even though copper is priced', () => {
  // SRR sells aluminium through this tool. The sheet still prices copper and
  // the estimator still handles it; it just is not put in front of a customer.
  const config = { pricing: pricingWith('Aluminum', 'Copper'), rules: {} };
  assert.deepEqual(offeredMaterials(config), ['Aluminum']);
});

test('the sheet can widen the offer without touching code', () => {
  const pricing = pricingWith('Aluminum', 'Copper');
  assert.deepEqual(
    offeredMaterials({ pricing, rules: { materials_offered: 'Aluminum, Copper' } }),
    ['Aluminum', 'Copper']);
  assert.deepEqual(
    offeredMaterials({ pricing, rules: { materials_offered: 'Copper' } }),
    ['Copper']);
  assert.deepEqual(
    offeredMaterials({ pricing, rules: { materials_offered: '*' } }),
    ['Aluminum', 'Copper']);
});

test('the list is matched case insensitively and tolerates loose spacing', () => {
  const pricing = pricingWith('Aluminum', 'Copper');
  assert.deepEqual(
    offeredMaterials({ pricing, rules: { materials_offered: '  copper ,ALUMINUM  ' } }),
    ['Aluminum', 'Copper']);
});

test('a rule naming nothing we stock still leaves something to pick', () => {
  // Better to show the real options than to hand the customer an empty form.
  const config = {
    pricing: pricingWith('Aluminum'),
    rules: { materials_offered: 'Zinc' },
  };
  assert.deepEqual(offeredMaterials(config), ['Aluminum']);
});

test('the default material is aluminium when it is on offer', async () => {
  const { initialState } = await import('../src/ui.js');
  const config = {
    pricing: pricingWith('Aluminum', 'Copper'),
    rules: { default_gutter_profile: 'K Style 5"' },
  };
  assert.equal(initialState(config).material, 'Aluminum');
});

import { renderMeasurement, traceReadout } from '../src/ui.js';

test('an address that was found but has no outline offers tracing, not "not found"', () => {
  const html = renderMeasurement({
    lookupStatus: 'error', lookupReasonCode: 'no-outline',
    lookupError: 'There is no building outline on file for that address yet.',
    lookupPoint: { lat: 34.18, lon: -117.29 }, traceCorners: [],
  });
  assert.match(html, /We found your address/);
  assert.match(html, /id="trace-map"/);
  assert.match(html, /id="use-trace"[^>]*disabled/);
  assert.match(html, /size of the home/);
  assert.doesNotMatch(html, /could not find/i);
});

test('an address the geocoder could not place says so, with tips', () => {
  const html = renderMeasurement({
    lookupStatus: 'error', lookupReasonCode: 'no-address',
    lookupError: 'We could not find that address on the map.', lookupPoint: null,
  });
  assert.match(html, /We could not find that address/);
  assert.match(html, /unit or\s+apartment number/);
  assert.doesNotMatch(html, /trace-map/);
});

test('the trace readout counts corners and reports the perimeter', () => {
  assert.match(traceReadout([], 0), /first corner/);
  assert.match(traceReadout([{}, {}], 0), /2 corners placed/);
  assert.match(traceReadout([{}, {}, {}, {}], 158.6), /4 corners, about <strong>159 ft/);
});
