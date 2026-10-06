/**
 * Tell SRR someone just downloaded an estimate.
 *
 * The customer's name, phone and email are all OPTIONAL. A download with none
 * of them still notifies - it is still a lead, with an address and a price -
 * so the email always says plainly which details were left blank.
 *
 * `buildLead` is pure and tested. `sendLead` is the thin network shell; it
 * never throws and never blocks the download, because a failed notification
 * must not cost the customer their estimate.
 */

import { NOTIFY_ENDPOINT } from './providers.js';
import { chosenColor } from './colors.js';

const LIMITS = { name: 100, phone: 40, email: 200, address: 300 };

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Loose on purpose: a typo'd email is still worth a phone call. */
export function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());
}

/** At least 10 digits, which covers (626) 555-0100, 626.555.0100, +1 626... */
export function looksLikePhone(v) {
  return String(v ?? '').replace(/\D/g, '').length >= 10;
}

/**
 * The free 10-year warranty is the reason to leave details: a name, plus a
 * phone or an email we can actually reach them on. Shared by the page, the
 * estimate and the lead email so all three agree on who qualifies.
 */
export function qualifiesForWarranty(contact = {}) {
  return clip(contact.name, 999) !== ''
    && (looksLikePhone(contact.phone) || looksLikeEmail(contact.email));
}

/**
 * Check what the customer typed. Blank is always fine; something typed that
 * cannot be a phone number or an email gets a message, so the estimate is
 * not printed with a number nobody can call.
 *
 * @returns {{ ok: boolean, errors: { phone?: string, email?: string } }}
 */
export function validateContact(contact = {}) {
  const errors = {};
  if (clip(contact.phone, 99) && !looksLikePhone(contact.phone)) {
    errors.phone = 'Please check the phone number - it needs the area code.';
  }
  if (clip(contact.email, 999) && !looksLikeEmail(contact.email)) {
    errors.email = 'Please check the email address.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** The customer details as they go on the estimate: trimmed, length capped. */
export function cleanContact(contact = {}) {
  return {
    name: clip(contact.name, LIMITS.name),
    phone: clip(contact.phone, LIMITS.phone),
    email: clip(contact.email, LIMITS.email),
  };
}

/**
 * The form fields posted to the PHP script.
 *
 * @param {object} input
 * @param {object} input.contact   { name, phone, email }
 * @param {string} input.address
 * @param {object} input.result    an estimate() result
 * @param {object} input.state     the page state (material, profile...)
 * @param {string} [input.honeypot] the hidden field bots fill in
 */
export function buildLead({ contact, address, result, state, honeypot = '', page = '' }) {
  const c = cleanContact(contact);
  const q = result?.quantities ?? {};
  const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : '');
  return {
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: clip(address, LIMITS.address),
    total: money(result?.total),
    range: result ? `${money(result.lowBand)} - ${money(result.highBand)}` : '',
    job: result
      ? `${q.billableLF} LF ${String(state?.material ?? '').toLowerCase()} `
        + `${state?.profile ?? ''}, ${q.downspoutCount} downspouts, `
        + `${state?.stories ?? 1} ${state?.stories === 1 ? 'story' : 'stories'}`
        + `${state?.guards ? ', with gutter guards' : ''}`
      : '',
    color: chosenColor(state) ?? '',
    warranty: qualifiesForWarranty(contact) ? 'yes' : 'no',
    page: clip(page, 200),
    website: honeypot,   // the honeypot travels under a boring name
  };
}

/**
 * Post the lead. Form-encoded, so the browser sends it without a CORS
 * preflight, and `keepalive` so it survives the customer closing the tab the
 * moment the PDF lands.
 *
 * Never sends from localhost: development must not email the office. Add
 * ?notify=1 to the URL to test the real thing from a dev server.
 *
 * @returns {Promise<boolean>} whether the script accepted it
 */
export async function sendLead(lead, deps = {}) {
  const loc = deps.location ?? (typeof location !== 'undefined' ? location : null);
  const local = loc && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname);
  if (local && !new URLSearchParams(loc.search).has('notify')) {
    console.info('Lead notification skipped on localhost (add ?notify=1 to send):', lead);
    return false;
  }
  const f = deps.fetch ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return false;
  try {
    const res = await f(deps.endpoint ?? NOTIFY_ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams(lead),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}
