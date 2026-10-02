/**
 * Lead capture: the optional contact fields, the warranty line, and what gets
 * posted to the notification script. The network call itself is stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildConfig } from '../src/config.js';
import { estimate } from '../src/estimator.js';
import { generateSow, warrantyText, customerRows } from '../src/sow.js';
import { sowPdfModel } from '../src/pdf.js';
import {
  validateContact, cleanContact, buildLead, sendLead,
} from '../src/notify.js';
import { renderContactFields } from '../src/ui.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = buildConfig(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'pricing.csv'), 'utf8'),
  readFileSync(join(ROOT, 'tests', 'fixtures', 'rules.csv'), 'utf8'),
  'test'
);
const DATE = new Date(2026, 8, 21);
const ADDRESS = '410 W 59th St, San Bernardino, CA 92407';
const STATE = { measuredLF: 172, stories: 1, material: 'Aluminum', profile: 'K Style 5"' };
const result = () => estimate(config, STATE);
const CUSTOMER = { name: 'Pat Example', phone: '(626) 555-0100', email: 'pat@example.com' };

// ---- warranty -------------------------------------------------------------

test('every estimate carries the 10-year warranty, in both formats', () => {
  assert.match(warrantyText(config.rules), /10-year warranty/);
  assert.match(warrantyText(config.rules), /Specialist Roofing/);
  const pdf = sowPdfModel(config, result(), { address: ADDRESS, date: DATE });
  assert.match(pdf.warranty, /10-year warranty/);
  assert.match(generateSow(config, result(), { address: ADDRESS, date: DATE }),
    /WARRANTY[\s\S]*10-year warranty/);
});

test('the Rules tab can reword the warranty without a deploy', () => {
  const rules = { ...config.rules, warranty_text: '{company}: 10 years, parts and labor.' };
  assert.equal(warrantyText(rules), `${config.rules.company_name}: 10 years, parts and labor.`);
  assert.match(warrantyText({ ...config.rules, warranty_text: 'TBD' }), /10-year warranty/);
});

// ---- the customer on the estimate ----------------------------------------

test('name, phone and email print on the estimate when given', () => {
  const facts = Object.fromEntries(sowPdfModel(config, result(),
    { address: ADDRESS, date: DATE, customer: CUSTOMER }).facts);
  assert.equal(facts['Prepared for'], 'Pat Example');
  assert.equal(facts.Phone, '(626) 555-0100');
  assert.equal(facts.Email, 'pat@example.com');

  const text = generateSow(config, result(), { address: ADDRESS, date: DATE, customer: CUSTOMER });
  assert.match(text, /Prepared for:\s+Pat Example/);
  assert.match(text, /Phone:\s+\(626\) 555-0100/);
});

test('blank details leave no empty rows behind', () => {
  assert.deepEqual(customerRows({ name: '  ', phone: '', email: undefined }), []);
  assert.deepEqual(customerRows({ phone: '626 555 0100' }), [['Phone', '626 555 0100']]);
  const facts = sowPdfModel(config, result(), { address: ADDRESS, date: DATE }).facts;
  assert.equal(facts[0][0], 'Date');
});

// ---- validation -----------------------------------------------------------

test('every contact field is optional', () => {
  assert.equal(validateContact({}).ok, true);
  assert.equal(validateContact({ name: '', phone: '  ', email: '' }).ok, true);
});

test('a phone needs an area code; an email needs to look like one', () => {
  assert.equal(validateContact({ phone: '555-0100' }).errors.phone !== undefined, true);
  assert.equal(validateContact({ phone: '(626) 555-0100' }).ok, true);
  assert.equal(validateContact({ phone: '+1 626.555.0100' }).ok, true);
  assert.ok(validateContact({ email: 'pat@example' }).errors.email);
  assert.equal(validateContact({ email: 'pat@example.com' }).ok, true);
});

test('details are trimmed, single-spaced and length-capped', () => {
  const c = cleanContact({ name: '  Pat \n  Example ', phone: 'x'.repeat(99) });
  assert.equal(c.name, 'Pat Example');
  assert.equal(c.phone.length, 40);
});

// ---- the notification -----------------------------------------------------

test('the lead carries contact, address and the job in plain words', () => {
  const lead = buildLead({
    contact: CUSTOMER, address: ADDRESS, result: result(),
    state: { ...STATE, guards: true },
  });
  assert.equal(lead.name, 'Pat Example');
  assert.equal(lead.phone, '(626) 555-0100');
  assert.equal(lead.email, 'pat@example.com');
  assert.equal(lead.address, ADDRESS);
  assert.match(lead.total, /^\$[\d,]+$/);
  assert.match(lead.range, /^\$[\d,]+ - \$[\d,]+$/);
  assert.match(lead.job, /aluminum K Style 5", \d+ downspouts, 1 story, with gutter guards/);
  assert.equal(lead.website, '');
});

test('the lead posts form-encoded with keepalive, and never from localhost', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const lead = buildLead({ contact: {}, address: '', result: result(), state: STATE });

  const local = await sendLead(lead, {
    fetch: fakeFetch, location: { hostname: 'localhost', search: '' } });
  assert.equal(local, false);
  assert.equal(calls.length, 0);

  const live = await sendLead(lead, {
    fetch: fakeFetch, location: { hostname: 'srrgutters.com', search: '' } });
  assert.equal(live, true);
  assert.equal(calls[0].url, 'https://srrgutters.com/api/estimate-notify.php');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.keepalive, true);
  assert.ok(calls[0].opts.body instanceof URLSearchParams);
});

test('a failed notification never throws into the download', async () => {
  const boom = async () => { throw new Error('offline'); };
  const ok = await sendLead({}, { fetch: boom, location: { hostname: 'srrgutters.com', search: '' } });
  assert.equal(ok, false);
});

// ---- the fields -----------------------------------------------------------

test('the contact fields say optional, keep typed values, and show errors', () => {
  const html = renderContactFields({
    contact: { name: 'Pat <b>', phone: '555', email: '' },
    contactErrors: { phone: 'Please check the phone number - it needs the area code.' },
  });
  assert.match(html, /optional/);
  assert.match(html, /value="Pat &lt;b&gt;"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /needs the area code/);
  assert.match(html, /id="contact-website" tabindex="-1"/);
});
