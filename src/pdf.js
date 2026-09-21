/**
 * The statement of work as a PDF.
 *
 * Built client side with jsPDF from a CDN - no server, no build step, no keys,
 * consistent with everything else here. If jsPDF cannot be loaded the caller
 * falls back to the plain text version rather than leaving the button dead.
 *
 * `sow.js` stays the pure text generator and is still what the clipboard
 * button uses. This module draws the same information, and both read the same
 * estimate result, so they cannot disagree about a number.
 */

import { formatDate, addDays, slugifyAddress, dateStamp } from './sow.js';

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';

// Matches the brand tokens in styles.css.
const BLUE = [0, 63, 190];
const ORANGE = [255, 107, 39];
const NAVY = [7, 29, 71];
const INK = [16, 20, 28];
const INK_SOFT = [77, 86, 101];
const LINE = [200, 208, 220];

const PAGE = { w: 612, h: 792 };      // US Letter at 72dpi, in points
const M = 54;                          // margin
const CONTENT_W = PAGE.w - M * 2;

let jsPdfPromise = null;

/** Load jsPDF once. Resolves to the constructor, or null if it cannot load. */
export function loadJsPdf() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (jsPdfPromise) return jsPdfPromise;

  jsPdfPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = JSPDF_URL;
    script.async = true;
    script.onload = () => resolve(window.jspdf?.jsPDF ?? null);
    script.onerror = () => {
      console.warn('jsPDF failed to load; falling back to the text document.');
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return jsPdfPromise;
}

/**
 * Read the logo off the page and hand jsPDF a data URL it can embed.
 *
 * Downscaled first. The source is 1424px wide but it prints at 168pt, so
 * embedding it whole quadrupled the file size for no visible gain - 480px is
 * comfortably past what a 168pt box can show, even on a high-DPI print.
 */
const LOGO_MAX_PX = 480;

async function logoDataUrl() {
  const img = document.querySelector('.logo');
  if (!img) return null;
  try {
    await (img.decode?.() ?? Promise.resolve());
    const scale = Math.min(1, LOGO_MAX_PX / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { url: canvas.toDataURL('image/png'), w, h };
  } catch {
    // A tainted canvas or a logo that never loaded: draw the document without
    // it rather than failing the download.
    return null;
  }
}

const money = (n) => '$' + Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const qtyText = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

export function pdfFilename(address, date) {
  return `SRR-Gutter-Estimate-${slugifyAddress(address)}-${dateStamp(date)}.pdf`;
}

/**
 * Everything the PDF says, as data.
 *
 * PURE - no jsPDF, no DOM, no clock. Split out so the wording can be tested
 * and reviewed without rendering anything; `generateSowPdf` below only decides
 * where on the page each piece goes.
 */
export function sowPdfModel(config, result, meta) {
  const { rules } = config;
  const { address, date } = meta;
  const i = result.inputs;
  const q = result.quantities;

  const company = rules.company_name || 'Specialist Roofing & Repair';
  const phone = String(rules.company_phone ?? '').trim();
  const license = String(rules.company_license ?? '').trim();
  const validDays = Number(rules.estimate_validity_days) || 30;
  const real = (v) => v && v.toUpperCase() !== 'TBD';

  return {
    company,
    phone: real(phone) ? phone : null,
    license: real(license) ? license : null,
    validDays,
    facts: [
      ['Date', formatDate(date)],
      ['Property address', address || '(not supplied)'],
      ['Valid until', `${formatDate(addDays(date, validDays))}  (${validDays} days)`],
    ],
    scope: [
      `Furnish and install ${q.billableLF} linear feet of ${i.material.toLowerCase()} `
        + `${i.profile} rain gutter, including ${q.downspoutCount} downspouts totalling `
        + `approximately ${q.downspoutLF} linear feet over ${i.stories} `
        + `${i.stories === 1 ? 'story' : 'stories'}.`,
      q.guardLF > 0
        ? `Install ${q.guardLF} linear feet of gutter guard, sized to the profile above.`
        : null,
      'Work includes all hangers, elbows, corners, end caps, straps, sealant, '
        + 'fasteners and labor required to complete the installation in a '
        + 'workmanlike manner.',
      q.tearOffLF > 0
        ? 'Existing gutters and downspouts to be removed and hauled away.'
        : null,
      'All debris generated by this work to be removed from the property on completion.',
    ].filter(Boolean).join(' '),
    exclusions: EXCLUSIONS,
    disclaimer: disclaimerText(company, validDays),
  };
}

const EXCLUSIONS = [
  'Repair or replacement of fascia board, rafter tails or any rotted or damaged substrate found during removal.',
  'Painting, priming or finishing of gutters, downspouts or fascia.',
  'Underground drainage, drywells, tie-ins to existing subsurface drain lines, and any trenching.',
  'Roofing repairs, tile or shingle work, flashing, and any work above the gutter line.',
  'Permits, engineering, HOA submissions and any associated fees.',
  'Removal or reinstatement of solar equipment, satellite dishes, cameras or lighting.',
  'Work requiring scaffolding, lift equipment or removal of landscaping for access.',
  'Correction of pre-existing roof pitch, fascia slope or framing that prevents proper drainage.',
];

/**
 * THE LEGAL VERBIAGE. Printed on every document, in full, above the signature
 * space. The page itself no longer carries a disclaimer, so this is where it
 * lives - it must never be quietly trimmed to make the layout fit.
 */
function disclaimerText(company, validDays) {
  return [
    `THIS IS AN ESTIMATE, NOT A BINDING QUOTE OR A CONTRACT. The figures above `
    + `are APPROXIMATE. They are derived from public building-outline data, `
    + `aerial imagery and details supplied by the customer, none of which have `
    + `been verified on site.`,
    `Actual measurements, access conditions, the condition of the fascia and `
    + `existing drainage may change the price. No work is authorised and no `
    + `price is fixed until ${company} has completed a site visit and both `
    + `parties have signed a written contract.`,
    `This estimate is valid for ${validDays} days from the date shown above and `
    + `is subject to change thereafter. Quantities not priced on this document `
    + `are not included in the total.`,
  ];
}

/**
 * Draw the statement of work.
 *
 * @param {object} config  { rules }
 * @param {object} result  an estimate() result
 * @param {object} meta    { address, date }
 * @returns {Promise<Blob|null>} null when jsPDF is unavailable
 */
export async function generateSowPdf(config, result, meta) {
  const JsPDF = await loadJsPdf();
  if (!JsPDF) return null;

  const model = sowPdfModel(config, result, meta);
  const { company, phone, license, validDays } = model;

  const doc = new JsPDF({ unit: 'pt', format: 'letter', compress: true });
  let y = M;

  const setFont = (size, style = 'normal', colour = INK) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...colour);
  };

  /** Start a new page when the next block would not fit. */
  const need = (h) => {
    if (y + h <= PAGE.h - M - 28) return;
    footer();
    doc.addPage();
    y = M;
  };

  let pageNo = 0;
  const footer = () => {
    pageNo += 1;
    setFont(7.5, 'normal', INK_SOFT);
    doc.text(`${company}${license ? `  ·  License #${license}` : ''}`, M, PAGE.h - 34);
    doc.text(`Page ${pageNo}`, PAGE.w - M, PAGE.h - 34, { align: 'right' });
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.5);
    doc.line(M, PAGE.h - 46, PAGE.w - M, PAGE.h - 46);
  };

  const heading = (text) => {
    need(30);
    setFont(10, 'bold', BLUE);
    doc.text(text.toUpperCase(), M, y);
    y += 5;
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(1.5);
    doc.line(M, y, M + 34, y);
    y += 14;
  };

  const para = (text, size = 9.5, colour = INK) => {
    setFont(size, 'normal', colour);
    const lines = doc.splitTextToSize(text, CONTENT_W);
    need(lines.length * (size + 3));
    doc.text(lines, M, y);
    y += lines.length * (size + 3) + 6;
  };

  // ---- header -----------------------------------------------------------
  const logo = await logoDataUrl();
  if (logo) {
    const w = 168;
    const h = (logo.h / logo.w) * w;
    doc.addImage(logo.url, 'PNG', M, y, w, h);
    y += h + 6;
  } else {
    setFont(18, 'bold', BLUE);
    doc.text(company, M, y + 14);
    y += 26;
  }

  // Phone sits top right, where anyone scanning the page looks for it.
  setFont(13, 'bold', BLUE);
  if (phone) doc.text(phone, PAGE.w - M, M + 14, { align: 'right' });
  setFont(8, 'normal', INK_SOFT);
  doc.text('specialistroofing.com', PAGE.w - M, M + 27, { align: 'right' });
  if (license) doc.text(`License #${license}`, PAGE.w - M, M + 38, { align: 'right' });

  y = Math.max(y, M + 52);
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(2);
  doc.line(M, y, PAGE.w - M, y);
  y += 22;

  setFont(16, 'bold', NAVY);
  doc.text('Gutter Estimate', M, y);
  y += 16;
  setFont(9, 'normal', INK_SOFT);
  doc.text('Statement of work', M, y);
  y += 20;

  // ---- the facts --------------------------------------------------------
  for (const [k, v] of model.facts) {
    setFont(8.5, 'bold', INK_SOFT);
    doc.text(k.toUpperCase(), M, y);
    setFont(10, 'normal', INK);
    doc.text(String(v), M + 108, y);
    y += 15;
  }
  y += 10;

  // ---- scope ------------------------------------------------------------
  heading('Scope of work');
  para(model.scope);
  y += 4;

  // ---- line items -------------------------------------------------------
  heading('Line items');

  const col = { name: M, qty: M + 292, uom: M + 340, rate: M + 400, amount: PAGE.w - M };
  setFont(7.5, 'bold', INK_SOFT);
  doc.text('DESCRIPTION', col.name, y);
  doc.text('QTY', col.qty, y, { align: 'right' });
  doc.text('UOM', col.uom, y);
  doc.text('RATE', col.rate, y, { align: 'right' });
  doc.text('AMOUNT', col.amount, y, { align: 'right' });
  y += 5;
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(1);
  doc.line(M, y, PAGE.w - M, y);
  y += 13;

  for (const line of result.lines) {
    need(30);
    setFont(9.5, 'normal', INK);
    doc.text(doc.splitTextToSize(line.name, 280)[0], col.name, y);
    doc.text(qtyText(line.qty), col.qty, y, { align: 'right' });
    doc.text(line.uom, col.uom, y);
    doc.text(money(line.unitPrice), col.rate, y, { align: 'right' });
    setFont(9.5, 'bold', INK);
    doc.text(money(line.lineTotal), col.amount, y, { align: 'right' });

    // The SRR material code, which is what makes this a work order.
    y += 11;
    setFont(7.5, 'normal', INK_SOFT);
    doc.text(line.code, col.name + 8, y);
    y += 6;
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.5);
    doc.line(M, y, PAGE.w - M, y);
    y += 13;
  }

  need(70);
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(1);
  doc.line(M, y - 4, PAGE.w - M, y - 4);
  y += 12;
  setFont(13, 'bold', NAVY);
  doc.text('TOTAL', col.rate, y, { align: 'right' });
  doc.text(money(result.total), col.amount, y, { align: 'right' });
  y += 15;
  setFont(8.5, 'normal', INK_SOFT);
  doc.text(`Approximate range  ${money(result.lowBand)} to ${money(result.highBand)}`,
    col.amount, y, { align: 'right' });
  y += 22;

  if (result.unpriced.length) {
    heading('Included in the work, not yet priced');
    para('These quantities are part of the scope above but are not included in '
       + 'the total.', 9, INK_SOFT);
    for (const u of result.unpriced) {
      need(14);
      setFont(9, 'normal', INK);
      doc.text(`${u.name}`, M, y);
      doc.text(`${qtyText(u.qty)} ${u.uom || 'EA'}`, col.amount, y, { align: 'right' });
      y += 13;
    }
    y += 10;
  }

  // ---- exclusions -------------------------------------------------------
  heading('Exclusions');
  for (const ex of model.exclusions) {
    setFont(8.5, 'normal', INK);
    const lines = doc.splitTextToSize(ex, CONTENT_W - 14);
    need(lines.length * 11 + 2);
    doc.text('•', M, y);
    doc.text(lines, M + 12, y);
    y += lines.length * 11 + 3;
  }
  y += 12;

  // ---- the disclaimer ---------------------------------------------------
  need(120);
  doc.setFillColor(246, 247, 250);
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(2);

  const blockTop = y;
  setFont(9, 'bold', NAVY);
  const wrapped = model.disclaimer.map((t) => doc.splitTextToSize(t, CONTENT_W - 26));
  const blockH = wrapped.reduce((n, l) => n + l.length * 11, 0) + 30;

  doc.rect(M, blockTop, CONTENT_W, blockH, 'F');
  doc.line(M, blockTop, M, blockTop + blockH);

  y = blockTop + 16;
  wrapped.forEach((lines, idx) => {
    setFont(8.5, idx === 0 ? 'bold' : 'normal', idx === 0 ? NAVY : INK);
    doc.text(lines, M + 13, y);
    y += lines.length * 11 + 6;
  });
  y = blockTop + blockH + 20;

  footer();
  return doc.output('blob');
}
