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
    fullAddress({ addressLine: '1061 N Victory Place', city: 'Burbank',
                  stateCode: 'CA', zip: '91502' }),
    '1061 N Victory Place, Burbank, CA 91502');
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
  const street = { addressLine: '1061 N Victory Place' };
  assert.equal(addressIsUsable({ ...street, city: 'Burbank' }), true);
  assert.equal(addressIsUsable({ ...street, zip: '91502' }), true);
  assert.equal(addressIsUsable({ ...street, city: '', zip: '' }), false,
    'a street alone is too vague to geocode');
  assert.equal(addressIsUsable({ city: 'Burbank', zip: '91502' }), false,
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

import { progressSteps, renderProgress, renderContactFields, warrantyStatus } from '../src/ui.js';

const done = (state) => progressSteps(state).filter((s) => s.done).map((s) => s.key);
const current = (state) => progressSteps(state).find((s) => s.current)?.key;

test('the progress bar moves only for what the customer has done', () => {
  assert.deepEqual(done({}), []);
  assert.equal(current({}), 'address');

  const addr = { addressLine: '410 W 59th St', zip: '92407' };
  assert.deepEqual(done(addr), ['address']);
  assert.equal(current(addr), 'measure');

  const measured = { ...addr, measuredLF: 180 };
  assert.deepEqual(done(measured), ['address', 'measure']);
  assert.equal(current(measured), 'style');

  assert.deepEqual(done({ ...measured, styleTouched: true }), ['address', 'measure', 'style']);
  // Downloading accepts the pre-selected style, so everything is ticked.
  assert.deepEqual(done({ ...measured, estimateSaved: true }),
    ['address', 'measure', 'style', 'estimate']);
});

test('skipping the address leaves that step open, not the bar stuck', () => {
  const s = { measuredLF: 200, styleTouched: true };
  assert.deepEqual(done(s), ['measure', 'style']);
  assert.equal(current(s), 'address');
});

test('the bar renders its fill and a tick per finished step', () => {
  const html = renderProgress({ addressLine: '1 Main St', zip: '91502', measuredLF: 150 });
  assert.match(html, /width:50%/);
  assert.match(html, /aria-valuenow="2"/);
  assert.equal((html.match(/&#10003;/g) ?? []).length, 2);
  assert.match(html, /aria-current="step"/);
});

test('the contact block offers the free 10-year warranty, and confirms it', () => {
  const html = renderContactFields({ contact: {} });
  assert.match(html, /free 10-year warranty/);
  assert.equal(warrantyStatus({ name: 'Pat' }), '');
  assert.match(warrantyStatus({ name: 'Pat', phone: '(626) 555-0100' }), /You qualify/);
});

import { renderProgressRail, progressMessage, renderForm, renderResult, initialState } from '../src/ui.js';
import { buildConfig as buildCfg } from '../src/config.js';
import { readFileSync as readFs } from 'node:fs';

test('the side rail cheers them on and fills to the step they are on', () => {
  assert.equal(progressMessage(0, 4), 'Let&rsquo;s get started');
  assert.equal(progressMessage(2, 4), '2 of 4 done');
  assert.equal(progressMessage(3, 4), 'Almost done!');
  assert.equal(progressMessage(4, 4), 'All done!');

  assert.match(renderProgressRail({}), /height:0%/);
  const two = renderProgressRail({ addressLine: '1 Main St', zip: '91502', measuredLF: 150 });
  assert.match(two, /height:67%/);
  assert.match(two, /2 of 4 done/);
  assert.match(renderProgressRail({ addressLine: '1 Main St', zip: '91502',
    measuredLF: 150, estimateSaved: true }), /height:100%/);
});

const cfg = buildCfg(
  readFs(new URL('./fixtures/pricing.csv', import.meta.url), 'utf8'),
  readFs(new URL('./fixtures/rules.csv', import.meta.url), 'utf8'), 'test');

test('address and linear feet sit side by side, without the trimmed copy', () => {
  const html = renderForm(cfg, initialState(cfg));
  assert.match(html, /Measure from my address[\s\S]*>or<[\s\S]*I know my linear feet/);
  assert.match(html, /id="measuredLF"/);
  assert.doesNotMatch(html, /every number stays editable/);
  assert.doesNotMatch(html, /we will look up your building outline/);
  assert.doesNotMatch(html, /name="roofType"/);
});

test('the result offers the PDF only - no clipboard button', () => {
  const html = renderResult(cfg, { ...initialState(cfg), measuredLF: 180 });
  assert.match(html, /id="download-sow"/);
  assert.doesNotMatch(html, /copy-sow|clipboard/i);
});

test('"Is this your building?" carries no explanation paragraph', () => {
  const html = renderMeasurement({ measurement: {
    ok: true, method: 'osm', coords: [{ lat: 0, lon: 0 }], sides: [], confidence: 'likely',
  } }, null);
  assert.match(html, /Is this your building\?/);
  assert.doesNotMatch(html, /We pulled an approximate outline/);
  assert.doesNotMatch(html, /class="hint"/);
});
