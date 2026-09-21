/**
 * Statement of work PDF: content tests.
 *
 * The drawing is layout and is not tested here. What IS tested is everything
 * the document SAYS - above all the legal wording, which is the only
 * disclaimer left anywhere now that the page body carries none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildConfig } from '../src/config.js';
import { estimate } from '../src/estimator.js';
import { sowPdfModel, pdfFilename } from '../src/pdf.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = buildConfig(
  readFileSync(join(ROOT, 'data', 'pricing.csv'), 'utf8'),
  readFileSync(join(ROOT, 'data', 'rules.csv'), 'utf8'),
  'test'
);

const DATE = new Date(2026, 8, 21);
const ADDRESS = '5031 Fair Avenue, North Hollywood, CA 91601';

const worked = (o = {}) => estimate(config, {
  measuredLF: 334, stories: 2, material: 'Aluminum', profile: 'K Style 5"', ...o,
});
const model = (r = worked(), cfg = config) =>
  sowPdfModel(cfg, r, { address: ADDRESS, date: DATE });

// ---------------------------------------------------------------------------

test('the document says, unambiguously, that it is not a binding quote', () => {
  const text = model().disclaimer.join(' ');
  assert.match(text, /THIS IS AN ESTIMATE, NOT A BINDING QUOTE OR A CONTRACT/);
  assert.match(text, /APPROXIMATE/);
  assert.match(text, /have been verified on site|verified on site/);
  assert.match(text, /No work is authorised and no price is fixed until/);
  assert.match(text, /signed a written contract/);
  assert.match(text, /valid for 30 days/);
});

test('the disclaimer names the company and the real validity period', () => {
  const custom = { ...config, rules: { ...config.rules,
    company_name: 'Acme Roofing', estimate_validity_days: 14 } };
  const text = model(worked(), custom).disclaimer.join(' ');
  assert.match(text, /Acme Roofing has completed a site visit/);
  assert.match(text, /valid for 14 days/);
});

test('the company phone and licence are carried onto the document', () => {
  const m = model();
  assert.equal(m.phone, config.rules.company_phone);
  assert.equal(m.license, String(config.rules.company_license));
  assert.equal(m.company, 'Specialist Roofing & Repair');
});

test('a placeholder phone or licence is omitted rather than printed as TBD', () => {
  const tbd = { ...config, rules: { ...config.rules,
    company_phone: 'TBD', company_license: 'TBD' } };
  const m = model(worked(), tbd);
  assert.equal(m.phone, null);
  assert.equal(m.license, null);
});

test('the facts block carries the date, the address and the expiry', () => {
  const facts = Object.fromEntries(model().facts);
  assert.equal(facts.Date, 'September 21, 2026');
  assert.equal(facts['Property address'], ADDRESS);
  assert.match(facts['Valid until'], /October 21, 2026/);
  assert.match(facts['Valid until'], /\(30 days\)/);
});

test('a missing address is stated, not left blank', () => {
  const m = sowPdfModel(config, worked(), { address: '', date: DATE });
  assert.equal(Object.fromEntries(m.facts)['Property address'], '(not supplied)');
});

test('the scope matches the quantities that were actually priced', () => {
  const r = worked();
  const s = model(r).scope;
  assert.ok(s.includes(`${r.quantities.billableLF} linear feet`));
  assert.ok(s.includes(`${r.quantities.downspoutCount} downspouts`));
  assert.match(s, /over 2 stories/);
  assert.match(s, /aluminum K Style 5" rain gutter/);
});

test('the scope never writes a zero quantity into a contract', () => {
  const s = model().scope;
  assert.doesNotMatch(s, /\b0 (linear feet|downspouts)/);
  assert.match(s, /Work includes all hangers, elbows, corners/);
  // Nothing is being torn off, so the document must not promise removal.
  assert.doesNotMatch(s, /Existing gutters and downspouts to be removed/);
});

test('gutter guards and tear off appear when they are actually in the job', () => {
  const s = model(worked({ guards: true })).scope;
  assert.match(s, /linear feet of gutter guard/);

  const cfg = { ...config, rules: { ...config.rules, tear_off_included: 1 } };
  const withTearOff = sowPdfModel(cfg, estimate(cfg, {
    measuredLF: 334, stories: 2, material: 'Aluminum', profile: 'K Style 5"',
  }), { address: ADDRESS, date: DATE }).scope;
  assert.match(withTearOff, /Existing gutters and downspouts to be removed/);
});

test('exclusions cover the expensive surprises', () => {
  const text = model().exclusions.join(' ');
  for (const must of ['fascia board', 'Painting', 'Underground drainage',
                      'Permits', 'solar equipment', 'scaffolding']) {
    assert.ok(text.includes(must), `exclusions must mention ${must}`);
  }
});

test('no cost or margin data reaches the document', () => {
  const dump = JSON.stringify(model(worked({ guards: true }))).toLowerCase();
  for (const forbidden of ['unit cost', 'unitcost', 'target_margin', 'cogs']) {
    assert.ok(!dump.includes(forbidden), `must not contain "${forbidden}"`);
  }
});

test('the filename is a .pdf named for the address and date', () => {
  assert.equal(pdfFilename(ADDRESS, DATE),
    'SRR-Gutter-Estimate-5031-fair-avenue-north-hollywood-ca-91601-20260921.pdf');
  assert.equal(pdfFilename('', DATE), 'SRR-Gutter-Estimate-estimate-20260921.pdf');
});
