/**
 * Aluminum gutter colors, from SRR's supplier color card.
 *
 * The hex values were sampled from the card image, so the swatches on screen
 * are a guide, not a match - screens and print both shift colors, which is
 * why the picker says to confirm against a physical sample.
 *
 * Color does not change the price. It is carried through to the statement of
 * work and the lead email so the job is ordered in the right coil.
 */

// Five rows of four, light to dark: whites and creams, tans, grays, browns,
// then black and the accent colors. The panel shows them in exactly this order.
export const GUTTER_COLORS = [
  { name: 'High Gloss White', hex: '#E8E2D2' },
  { name: 'Lo Gloss White', hex: '#E0DED2' },
  { name: 'Light Pecan', hex: '#CDC2AC' },
  { name: 'Cream', hex: '#D4C4A3' },

  { name: 'Ivory', hex: '#C4AA8F' },
  { name: 'Wicker', hex: '#B5A58E' },
  { name: 'Clay', hex: '#99907F' },
  { name: 'Buckskin Brown', hex: '#8D755D' },

  { name: 'Colonial Gray', hex: '#A0A39C' },
  { name: 'Dark Gray', hex: '#7D7C77' },
  { name: 'Terratone', hex: '#635F56' },
  { name: 'Tuxedo Gray', hex: '#51514F' },

  { name: 'Weathered Bronze', hex: '#4B4841' },
  { name: 'Royal Brown', hex: '#4E413B' },
  { name: 'Musket Brown', hex: '#473E37' },
  { name: 'Harvest Brown', hex: '#45423D' },

  { name: 'Black', hex: '#343635' },
  { name: 'Red', hex: '#694640' },
  { name: 'Green', hex: '#38493F' },
  { name: 'Blue', hex: '#62777C' },
];

export const colorHex = (name) => GUTTER_COLORS.find((c) => c.name === name)?.hex ?? null;

/** The colored coil is aluminum; copper is left natural. */
export const colorsApply = (material) => String(material ?? '').toLowerCase() === 'aluminum';

/**
 * The color that actually applies to this job: the customer's pick, but only
 * if it is a real color on the card and the material is one that comes in
 * colors. Anything else is null, meaning "not chosen".
 */
export function chosenColor(state = {}) {
  if (!colorsApply(state.material)) return null;
  return GUTTER_COLORS.find((c) => c.name === state.color)?.name ?? null;
}
