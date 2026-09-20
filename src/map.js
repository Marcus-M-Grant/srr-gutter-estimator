/**
 * Leaflet rendering and the building outline overlay.
 *
 * THIS MODULE IS OPTIONAL BY DESIGN. Every export degrades to a no-op if
 * Leaflet fails to load, the CDN is blocked, or the tile provider is down. The
 * measurement comes from the OSM footprint coordinates, not from the picture,
 * so nothing here is allowed to block an estimate.
 *
 * What the map IS for: phase 4 measured the geocoded point landing inside a
 * building polygon zero times out of eight, with 4-5 of every 8 addresses
 * having more than one building in range. Which building we picked is a guess.
 * This is where the customer corrects it.
 */

import {
  TILE_SATELLITE, TILE_SATELLITE_ATTRIBUTION,
  TILE_STREET, TILE_STREET_ATTRIBUTION,
  TILE_PRIMARY, OSM_ATTRIBUTION,
} from './providers.js';

const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';

const STYLE_CHOSEN = { color: '#FF6B27', weight: 3, fillColor: '#FF6B27', fillOpacity: 0.28 };
const STYLE_OTHER = { color: '#ffffff', weight: 2, dashArray: '5,5', fillColor: '#003FBE', fillOpacity: 0.12 };
const STYLE_HOVER = { color: '#ffffff', weight: 3, fillOpacity: 0.3 };

let leafletPromise = null;

/**
 * Load Leaflet from the CDN, once. Resolves to `L`, or to null if it cannot be
 * loaded - callers must handle null rather than assuming a map.
 */
export function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve(window.L ?? null);
    script.onerror = () => {
      console.warn('Leaflet failed to load; continuing without a map.');
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return leafletPromise;
}

/** Tile layer config. One line to swap; see README "Tile licensing". */
function tileConfig(L) {
  if (TILE_PRIMARY === 'street') {
    return L.tileLayer(TILE_STREET, {
      maxZoom: 19,
      attribution: `${TILE_STREET_ATTRIBUTION} | ${OSM_ATTRIBUTION}`,
    });
  }
  return L.tileLayer(TILE_SATELLITE, {
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: `${TILE_SATELLITE_ATTRIBUTION} | ${OSM_ATTRIBUTION}`,
  });
}

const toLatLngs = (coords) => coords.map((p) => [p.lat, p.lon]);

/**
 * Draw the measurement on a map.
 *
 * @param {HTMLElement} el          container
 * @param {object} measurement      a `measureAddress` result
 * @param {function} onSelect       called with an alternative's index when the
 *                                  customer taps a different building
 * @returns {Promise<object|null>}  a handle with `destroy()`, or null
 */
export async function renderBuildingMap(el, measurement, onSelect) {
  const L = await loadLeaflet();
  if (!L || !el || !measurement?.coords?.length) return null;

  let map;
  try {
    map = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false,   // do not hijack the page scroll on mobile
    });
  } catch (err) {
    console.warn('Could not create the map:', err);
    return null;
  }

  tileConfig(L).addTo(map);

  const chosen = L.polygon(toLatLngs(measurement.coords), STYLE_CHOSEN).addTo(map);
  chosen.bindTooltip('Your building', { direction: 'top' });

  // The alternatives are the whole point of this map: a tappable "not this
  // one?" for the cases where nearest-centroid guessed wrong.
  (measurement.alternatives ?? []).forEach((alt, i) => {
    const layer = L.polygon(toLatLngs(alt.coords), STYLE_OTHER).addTo(map);
    layer.bindTooltip(`Tap to choose this building instead (${Math.round(alt.perimeterFt)} ft around)`,
      { direction: 'top' });
    layer.on('mouseover', () => layer.setStyle(STYLE_HOVER));
    layer.on('mouseout', () => layer.setStyle(STYLE_OTHER));
    layer.on('click', () => onSelect?.(i));
  });

  // A small marker for where the address actually geocoded to - usually the
  // street frontage, which is exactly why confirmation is needed.
  if (measurement.point) {
    L.circleMarker([measurement.point.lat, measurement.point.lon], {
      radius: 5, color: '#ffffff', weight: 2,
      fillColor: '#003FBE', fillOpacity: 1,
    }).addTo(map).bindTooltip('Address location', { direction: 'top' });
  }

  // Frame the CHOSEN building, not the whole candidate set. Fitting every
  // candidate zooms out far enough that the customer cannot recognise their
  // own roof, which defeats the point of showing them a picture. The padding
  // is generous enough that close neighbours stay tappable.
  map.fitBounds(chosen.getBounds().pad(0.9), { maxZoom: 20 });

  // Leaflet mis-sizes itself inside a container that was hidden or has just
  // been inserted; nudge it once the browser has laid the page out.
  setTimeout(() => map.invalidateSize(), 0);

  return {
    map,
    destroy() {
      try { map.remove(); } catch { /* already gone */ }
    },
  };
}
