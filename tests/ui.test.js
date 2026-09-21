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
