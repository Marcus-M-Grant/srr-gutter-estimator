/**
 * Statement of work text generation.
 *
 * PURE, and a pure function of the estimate result specifically - it reads
 * `result`, `rules` and a caller-supplied date, and never touches the DOM, the
 * clock, or the pricing engine. That separation is the point: the wording and
 * layout below can be rewritten for a contract template without any risk of
 * moving a number.
 *
 * Output is fixed width at 72 columns so it pastes into a contract, an email,
 * or a work order without reflowing.
 */

const WIDTH = 72;

// Line items print the full description on its own line and the code plus the
// numbers underneath, so nothing gets truncated. `Code` is printed because it
// is what makes this convertible into a work order against yard stock.
const COL = { code: 32, qty: 6, uom: 4, rate: 10, amount: 12 };
const LABEL_W = 22; // assumptions label column

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const rule = (ch = '-') => ch.repeat(WIDTH);
const padR = (s, n) => String(s).slice(0, n).padEnd(n);
const padL = (s, n) => String(s).slice(0, n).padStart(n);

function centre(s) {
  const t = String(s);
  const left = Math.max(0, Math.floor((WIDTH - t.length) / 2));
  return ' '.repeat(left) + t;
}

/** 1234.5 -> "1,234.50" */
function amount(n) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/** Quantities print as integers when they are whole. */
function qtyText(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

export function formatDate(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/** Wrap prose to the page width, preserving deliberate blank lines. */
export function wrap(text, width = WIDTH, indent = '') {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = indent;
    for (const word of para.trim().split(/\s+/)) {
      if (line.trim() && (line + ' ' + word).length > width) {
        out.push(line.trimEnd());
        line = indent + word;
      } else {
        line = line.trim() ? `${line} ${word}` : indent + word;
      }
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out.join('\n');
}

/**
 * "Label:            value that wraps under a hanging indent".
 * The value is wrapped on its own so the label padding survives - passing the
 * whole line through wrap() would collapse it, because wrap() normalises
 * runs of whitespace.
 */
function labelled(label, value, labelWidth = LABEL_W) {
  const pad = ' '.repeat(labelWidth);
  return wrap(value, WIDTH - labelWidth)
    .split('\n')
    .map((ln, n) => ((n === 0 ? padR(`${label}:`, labelWidth) : pad) + ln).trimEnd())
    .join('\n');
}

/** "5031 Fair Avenue, North Hollywood, CA" -> "5031-fair-avenue-north-hollywood-ca" */
export function slugifyAddress(address) {
  const slug = String(address ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'estimate';
}

/** YYYYMMDD */
export function dateStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function sowFilename(address, date) {
  return `SRR-Gutter-Estimate-${slugifyAddress(address)}-${dateStamp(date)}.txt`;
}

/** How the footage was arrived at, in plain words. */
function sourcePhrase(lfSource) {
  switch (lfSource) {
    case 'osm':
      return 'measured from the building outline on file for this address';
    case 'sqft':
      return 'calculated from the home square footage and story count supplied '
           + 'by the customer';
    default:
      return 'supplied by the customer';
  }
}

function scopeParagraph(result, rules) {
  const i = result.inputs;
  const q = result.quantities;
  const material = i.material.toLowerCase();

  const parts = [
    `Furnish and install ${q.billableLF} linear feet of ${material} ` +
    `${i.profile} rain gutter, including ${q.downspoutCount} downspouts ` +
    `totalling approximately ${q.downspoutLF} linear feet over ` +
    `${i.stories} ${i.stories === 1 ? 'story' : 'stories'}.`,
  ];

  if (q.guardLF > 0) {
    parts.push(`Install ${q.guardLF} linear feet of gutter guard, sized to the ` +
               'gutter profile above.');
  }

  // Only itemise what the rules actually produce. When a quantity is zero the
  // part is covered by the gutter price rather than billed separately, and
  // writing "0 hidden hangers" into a contract would be nonsense.
  const itemised = [
    [q.hangerQty, 'hidden hangers'],
    [q.elbowQty, 'elbows'],
    [q.miterQty, 'mitered corners'],
    [q.endCapQty, 'end caps'],
    [q.strapQty, 'downspout straps'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${qtyText(n)} ${label}`);

  if (itemised.length) {
    const last = itemised.pop();
    const list = itemised.length ? `${itemised.join(', ')} and ${last}` : last;
    parts.push(
      `Work includes ${list}, together with sealant, fasteners and all labor ` +
      'to complete the installation in a workmanlike manner.'
    );
  } else {
    parts.push(
      'Work includes all hangers, elbows, corners, end caps, straps, sealant, ' +
      'fasteners and labor required to complete the installation in a ' +
      'workmanlike manner.'
    );
  }

  if (q.tearOffLF > 0) {
    parts.push(
      'Existing gutters and downspouts to be removed and hauled away. All debris ' +
      'generated by this work to be removed from the property on completion.'
    );
  } else {
    parts.push(
      'All debris generated by this work to be removed from the property on ' +
      'completion.'
    );
  }

  void rules;
  return parts.join(' ');
}

const EXCLUSIONS = [
  'Repair or replacement of fascia board, rafter tails or any rotted or ' +
    'damaged substrate discovered during removal.',
  'Painting, priming or finishing of gutters, downspouts or fascia.',
  'Underground drainage, drywells, tie-ins to existing subsurface drain lines, ' +
    'and any trenching.',
  'Roofing repairs, tile or shingle work, flashing and any work above the ' +
    'gutter line.',
  'Permits, engineering, HOA submissions and any associated fees.',
  'Removal or reinstallation of solar equipment, satellite dishes, security ' +
    'cameras, lighting or holiday hardware.',
  'Work requiring scaffolding, lift equipment or removal of landscaping to ' +
    'obtain access.',
  'Correction of pre-existing roof pitch, fascia slope or framing conditions ' +
    'that prevent proper gutter drainage.',
];

/**
 * @param {object} config  { rules } from config.js
 * @param {object} result  the object returned by estimate()
 * @param {object} meta
 * @param {string} meta.address
 * @param {Date}   meta.date     pass it in; this module never reads the clock
 */
export function generateSow(config, result, meta) {
  const { rules } = config;
  const { address, date } = meta;
  const i = result.inputs;
  const L = [];

  const company = rules.company_name || 'Specialist Roofing & Repair';
  const phone = String(rules.company_phone ?? '').trim();
  const license = String(rules.company_license ?? '').trim();
  const validDays = Number(rules.estimate_validity_days) || 30;

  // ---- header ------------------------------------------------------------
  L.push(rule('='));
  L.push(centre(company.toUpperCase()));
  L.push(centre('GUTTER INSTALLATION - STATEMENT OF WORK'));
  L.push(rule('='));

  const contact = [
    phone && phone.toUpperCase() !== 'TBD' ? phone : null,
    license && license.toUpperCase() !== 'TBD' ? `License #${license}` : null,
  ].filter(Boolean);
  if (contact.length === 2) {
    L.push(padR(contact[0], WIDTH - contact[1].length) + contact[1]);
  } else if (contact.length === 1) {
    L.push(contact[0]);
  }
  L.push('');

  // labelled() rather than plain padding, so a long address wraps under the
  // label instead of running off the 72 column page.
  L.push(labelled('Date', formatDate(date), 20));
  L.push(labelled('Property address', address || '(not supplied)', 20));
  L.push(labelled('Estimate valid',
    `${validDays} days, through ${formatDate(addDays(date, validDays))}`, 20));
  L.push('');

  // ---- scope -------------------------------------------------------------
  L.push(rule());
  L.push('SCOPE OF WORK');
  L.push(rule());
  L.push(wrap(scopeParagraph(result, rules)));
  L.push('');

  // ---- line items --------------------------------------------------------
  L.push(rule());
  L.push('LINE ITEMS');
  L.push(rule());
  L.push(
    padR('  CODE', COL.code) + ' ' +
    padL('QTY', COL.qty) + ' ' +
    padR('UOM', COL.uom) + ' ' +
    padL('RATE', COL.rate) + ' ' +
    padL('AMOUNT', COL.amount)
  );
  L.push(rule());

  for (const line of result.lines) {
    L.push(wrap(line.name));
    L.push((
      padR(`  ${line.code}`, COL.code) + ' ' +
      padL(qtyText(line.qty), COL.qty) + ' ' +
      padR(line.uom, COL.uom) + ' ' +
      padL(amount(line.unitPrice), COL.rate) + ' ' +
      padL(amount(line.lineTotal), COL.amount)
    ).trimEnd());
  }

  L.push(rule());
  L.push(padL(`TOTAL   $${amount(result.total)}`, WIDTH));
  L.push(padL(
    `Estimated range   $${amount(result.lowBand)} - $${amount(result.highBand)}`,
    WIDTH
  ));

  if (result.minimumApplied) {
    L.push('');
    L.push(wrap(
      `Note: this job falls below the company minimum of ` +
      `$${amount(rules.minimum_job_price)}, and has been priced at the minimum.`
    ));
  }
  L.push('');

  // ---- unpriced ----------------------------------------------------------
  if (result.unpriced.length) {
    L.push(rule());
    L.push('INCLUDED IN THE WORK, NOT YET PRICED');
    L.push(rule());
    L.push(wrap(
      'The following materials are part of the scope above. They are not yet ' +
      'in the published price list, so they are NOT included in the total. ' +
      'They will be priced before the contract is issued.'
    ));
    L.push('');
    for (const u of result.unpriced) {
      L.push(wrap(u.name));
      L.push((
        padR(`  ${u.code}`, COL.code) + ' ' +
        padL(qtyText(u.qty), COL.qty) + ' ' +
        padR(u.uom || 'EA', COL.uom)
      ).trimEnd());
    }
    L.push('');
  }

  // ---- assumptions -------------------------------------------------------
  const a = result.assumptions;
  L.push(rule());
  L.push('ASSUMPTIONS THIS PRICE IS BASED ON');
  L.push(rule());

  const assumptions = [
    ['Gutter footage', `${qtyText(i.measuredLF)} LF, ${sourcePhrase(a.lfSource)}`],
  ];
  if (Number.isFinite(a.perimeterFt)) {
    assumptions.push(['Building perimeter', `${qtyText(a.perimeterFt)} LF`]);
  }
  if (a.roofType) {
    assumptions.push(['Roof type', `${a.roofType} (factor ${a.roofFactor})`]);
  }
  assumptions.push(
    ['Waste factor', `${Math.round(a.wasteFactor * 100)}%, giving ${a.billableLF} billable LF`],
    ['Stories', String(i.stories)],
    ['Downspouts', `${a.downspoutRule}; ${a.downspoutFtPerStory} ft per story`],
    ['Corners counted', String(i.corners)],
    ['Separate runs', String(i.runs)],
    ['Gutter guards', i.guards ? 'Included' : 'Not included'],
  );

  for (const [k, v] of assumptions) L.push(labelled(k, v));
  L.push('');

  // ---- exclusions --------------------------------------------------------
  L.push(rule());
  L.push('EXCLUSIONS');
  L.push(rule());
  for (const ex of EXCLUSIONS) {
    L.push(wrap(`- ${ex}`, WIDTH, '  ').replace(/^ {2}- /, '- '));
  }
  L.push('');

  // ---- disclaimer --------------------------------------------------------
  L.push(rule());
  L.push('VALIDITY AND DISCLAIMER');
  L.push(rule());
  L.push(wrap(
    'This is an ESTIMATE, not a binding quote and not a contract. It is based ' +
    'on satellite imagery, published building outline data and details ' +
    'supplied by the customer, none of which have been verified on site.'
  ));
  L.push('');
  L.push(wrap(
    `Final pricing is confirmed by a ${company} estimator after a site visit. ` +
    'Actual footage, access conditions, fascia condition and existing drainage ' +
    'may change the price. This estimate is valid for ' +
    `${validDays} days from the date above.`
  ));
  L.push('');
  L.push(rule('='));

  return L.join('\n') + '\n';
}
