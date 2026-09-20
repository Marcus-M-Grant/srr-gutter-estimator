/**
 * Every external endpoint the site touches, one line each.
 *
 * All of these are keyless and free. If you ever find yourself adding a token
 * or an API key to this file, stop: the whole tool is built on the constraint
 * that there is no billing account anywhere.
 *
 * Swapping a provider should mean editing exactly one line in here.
 */

// --- Imagery ---------------------------------------------------------------
// Esri World Imagery. Keyless and goes to zoom 19+ in LA County, but Esri's
// terms for using ArcGIS Online tiles outside a subscription are not clearly
// permissive for a commercial site. See README "Tile licensing".
export const TILE_SATELLITE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const TILE_SATELLITE_ATTRIBUTION =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics';

// Unambiguously free, but not satellite. Set TILE_PRIMARY to this to remove
// all licensing doubt; the footprint overlay still does the visual confirming.
export const TILE_STREET = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_STREET_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// The one line to flip. 'satellite' or 'street'.
export const TILE_PRIMARY = 'satellite';

// --- Geocoding -------------------------------------------------------------
// US Census Geocoder: public domain, no key, no quota, US addresses only.
export const GEOCODER_CENSUS =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
export const GEOCODER_CENSUS_PARAMS = 'benchmark=Public_AR_Current&format=json';

// Fallback. Volunteer funded and rate limited to 1 req/sec. Geocode on submit
// only, never per keystroke - that is an explicit violation of their policy.
export const GEOCODER_NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// --- Building footprints ---------------------------------------------------
// This is where the measurement actually comes from. Keyless, CORS enabled,
// volunteer funded: cache hard and fail gracefully rather than retrying.
export const OVERPASS = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';

// --- Etiquette -------------------------------------------------------------
export const NETWORK_TIMEOUT_MS = 15000;

/**
 * Overpass and Nominatim rate-limit anonymous clients hard - the mirrors reply
 * "Please include a meaningful User-Agent string with your requests to avoid
 * rate-limiting" and refuse the query. Identifying ourselves is a condition of
 * using these volunteer-funded services, not a nicety.
 *
 * Browsers forbid scripts from setting User-Agent and send their own (plus an
 * Origin header), so this is only applied outside the browser - in the Node
 * probe script and the tests.
 */
export const USER_AGENT =
  'SRR-Gutter-Estimator/0.1 (+https://specialistroofing.com)';
export const OSM_ATTRIBUTION = 'Building outlines &copy; OpenStreetMap contributors';
