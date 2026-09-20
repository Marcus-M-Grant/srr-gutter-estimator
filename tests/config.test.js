/**
 * Config loader tests, driven by the shapes a real published Google Sheet
 * actually emits - which is not the same as the shapes a CSV file emits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRuleNumber, normalizeRules, normalizePricing, parseCsvFallback,
  buildConfig, validateConfig,
} from '../src/config.js';

test('a percent-formatted cell is read as a fraction, not NaN', () => {
  // Google publishes a cell formatted as a percentage as "10%". Number("10%")
  // is NaN, which took the whole config down the first time the live sheet
  // was connected - waste_factor went null and the site refused to quote.
  assert.equal(parseRuleNumber('10%'), 0.1);
  assert.equal(parseRuleNumber('45%'), 0.45);
  assert.equal(parseRuleNumber('7.5%'), 0.075);
  assert.equal(parseRuleNumber('100%'), 1);
});

test('a plain decimal still means itself', () => {
  assert.equal(parseRuleNumber('0.1'), 0.1);
  assert.equal(parseRuleNumber('35'), 35);
  assert.equal(parseRuleNumber('1.12'), 1.12);
  assert.equal(parseRuleNumber(0.62), 0.62);
});

test('currency and thousands separators are tolerated', () => {
  assert.equal(parseRuleNumber('$950'), 950);
  assert.equal(parseRuleNumber('1,250'), 1250);
  assert.equal(parseRuleNumber('$1,250.50'), 1250.5);
  assert.equal(parseRuleNumber(' 25 '), 25);
});

test('junk is NaN rather than a silently wrong number', () => {
  for (const bad of ['', '   ', 'TBD', 'abc', null, undefined]) {
    assert.ok(Number.isNaN(parseRuleNumber(bad)), `${JSON.stringify(bad)} must be NaN`);
  }
});

test('a percent-formatted waste_factor loads and validates', () => {
  const { rules } = normalizeRules([
    { Key: 'waste_factor', Value: '10%', Notes: '' },
    { Key: 'estimate_range_pct', Value: '0.1', Notes: '' },
    { Key: 'minimum_job_price', Value: '$950', Notes: '' },
  ]);
  assert.equal(rules.waste_factor, 0.1);
  assert.equal(rules.estimate_range_pct, 0.1);
  assert.equal(rules.minimum_job_price, 950);
});

test('a published sheet carries junk columns, which must be ignored', () => {
  // The Web_* mirror tabs have instruction text off to the right in column M,
  // so the published CSV has extra unnamed trailing columns.
  const csv = [
    'Code,Name,Description,Material,Category,Profile,UOM,Price,Active,CostOfSaleAccount,,,"PUBLISH THIS TAB, NOT ""Pricing""."',
    '"Gutter Alum K Style 5""","Gutter - K Style 5""","Gutter - K Style 5""",Aluminum,Gutter,"K Style 5""",LF,$16.36,TRUE,Misc. Subcontractor (COGS),,,Some note',
    ',,,,,,,,,,,,Another note line',
  ].join('\n');

  const rows = normalizePricing(parseCsvFallback(csv));
  assert.equal(rows.length, 1, 'the note-only row has no Code and is dropped');
  assert.equal(rows[0].code, 'Gutter Alum K Style 5"');
  assert.equal(rows[0].price, 16.36, 'a $ prefix must not break the price');
  assert.equal(rows[0].active, true);
});

test('target_margin is stripped even if it reaches the parser', () => {
  const { rules } = normalizeRules([
    { Key: 'target_margin', Value: '45%', Notes: 'internal' },
    { Key: 'waste_factor', Value: '10%', Notes: '' },
  ]);
  assert.equal('target_margin' in rules, false);
  assert.equal(rules.waste_factor, 0.1);
});

test('a broken price on an active row is an error, not a wrong quote', () => {
  const pricing = normalizePricing([
    { Code: 'X', Name: 'X', Material: 'Aluminum', Category: 'Gutter',
      Profile: 'K', UOM: 'LF', Price: 'ask us', Active: 'TRUE' },
  ]);
  const { errors } = validateConfig(pricing, {});
  assert.ok(errors.some((e) => /Price is not a number/.test(e)));
});

test('buildConfig surfaces the source it was given', () => {
  const c = buildConfig('Code,Name,Material,Category,UOM,Price,Active\n', 'Key,Value\n', 'sheet');
  assert.equal(c.source, 'sheet');
  assert.ok(c.errors.length, 'an empty sheet is an error, not a silent zero');
});

test('mirror padding rows are dropped, so the tabs can be dragged down safely', () => {
  // `=Pricing!A41` on an empty source row returns 0, not blank. Dragging the
  // mirror past the current data is how new rows appear automatically, so the
  // padding must not become junk SKUs.
  const csv = [
    'Code,Name,Description,Material,Category,Profile,UOM,Price,Active,CostOfSaleAccount',
    '"Gutter Alum K Style 5""","Gutter - K Style 5""",,Aluminum,Gutter,"K Style 5""",LF,16.36,TRUE,X',
    '0,0,0,0,0,0,0,0,0,0',
    '0,0,0,0,0,0,0,0,0,0',
  ].join('\n');

  const rows = normalizePricing(parseCsvFallback(csv));
  assert.equal(rows.length, 1, 'only the real row survives');
  assert.equal(rows[0].code, 'Gutter Alum K Style 5"');
});

test('padded rule rows are dropped too', () => {
  const { rules } = normalizeRules([
    { Key: 'waste_factor', Value: '10%', Notes: '' },
    { Key: '0', Value: '0', Notes: '0' },
    { Key: '', Value: '', Notes: '' },
  ]);
  assert.deepEqual(Object.keys(rules), ['waste_factor']);
});

test('a genuine row is never mistaken for padding', () => {
  const rows = normalizePricing([
    { Code: '0-RING-KIT', Name: 'Sealing kit', Material: 'Universal',
      Category: 'Accessory', UOM: 'EA', Price: '4.00', Active: 'TRUE' },
  ]);
  assert.equal(rows.length, 1, 'a code merely starting with 0 is real');
});
