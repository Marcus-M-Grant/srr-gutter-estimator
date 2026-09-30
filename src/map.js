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

  /**
   * Frame the CHOSEN building, not the whole candidate set. Fitting every
   * candidate zooms out far enough that the customer cannot recognise their
   * own roof, which defeats the point of showing them a picture. The padding
   * is generous enough that close neighbours stay tappable.
   *
   * ORDER MATTERS. Leaflet measures its container when it is created, and the
   * container has just been written into the DOM, so it can still read as zero
   * sized - fitBounds then computes a zoom for a 0x0 viewport and lands on the
   * whole world. Size it first, fit second, and repeat once the browser has
   * actually laid the page out.
   */
  const frame = () => {
    map.invalidateSize({ animate: false });
    map.fitBounds(chosen.getBounds().pad(0.9), { maxZoom: 20, animate: false });
  };
  frame();
  requestAnimationFrame(frame);
  setTimeout(frame, 120);

  return {
    map,
    destroy() {
      try { map.remove(); } catch { /* already gone */ }
    },
  };
}

const STYLE_TRACE = { color: '#FF6B27', weight: 3, fillColor: '#FF6B27', fillOpacity: 0.22 };
const STYLE_TRACE_OPEN = { color: '#FF6B27', weight: 3, dashArray: '6,6' };

/**
 * Let the customer trace their own roof, for addresses OpenStreetMap has no
 * outline for. The geocoder still found the house, so the map opens on the
 * address pin at rooftop zoom; each tap adds a corner, and corners can be
 * dragged to fine-tune (taps on a phone are rarely exact).
 *
 * The page is NOT re-rendered per tap - that would rebuild the map and throw
 * away the customer's pan and zoom. Instead `onChange` gets the corner list
 * and the caller updates a readout in place.
 *
 * @param {HTMLElement} el
 * @param {object} opts
 * @param {{lat:number, lon:number}} opts.point    where to centre the map
 * @param {{lat:number, lon:number}[]} [opts.corners]  corners already placed
 * @param {function} [opts.onChange]  called with the corner list after edits
 * @returns {Promise<object|null>} a handle with undo(), clear(), destroy()
 */
export async function renderTraceMap(el, { point, corners = [], onChange } = {}) {
  const L = await loadLeaflet();
  if (!L || !el || !point) return null;

  let map;
  try {
    map = L.map(el, { zoomControl: true, scrollWheelZoom: false });
  } catch (err) {
    console.warn('Could not create the tracing map:', err);
    return null;
  }
  tileConfig(L).addTo(map);

  let pts = corners.map((p) => ({ lat: p.lat, lon: p.lon }));
  const shape = L.layerGroup().addTo(map);
  const handles = L.layerGroup().addTo(map);

  L.circleMarker([point.lat, point.lon], {
    radius: 5, color: '#ffffff', weight: 2, fillColor: '#003FBE', fillOpacity: 1,
    interactive: false,
  }).addTo(map);

  const cornerIcon = L.divIcon({
    className: 'trace-corner', iconSize: [16, 16], iconAnchor: [8, 8],
  });

  const changed = () => onChange?.(pts.map((p) => ({ ...p })));

  function redraw() {
    shape.clearLayers();
    handles.clearLayers();
    const latlngs = pts.map((p) => [p.lat, p.lon]);
    if (pts.length >= 3) L.polygon(latlngs, STYLE_TRACE).addTo(shape);
    else if (pts.length === 2) L.polyline(latlngs, STYLE_TRACE_OPEN).addTo(shape);

    pts.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { icon: cornerIcon, draggable: true })
        .addTo(handles);
      m.on('drag', (e) => {
        const ll = e.target.getLatLng();
        pts[i] = { lat: ll.lat, lon: ll.lng };
        // Move the outline with the finger, but keep the marker being dragged.
        shape.clearLayers();
        const live = pts.map((q) => [q.lat, q.lon]);
        if (pts.length >= 3) L.polygon(live, STYLE_TRACE).addTo(shape);
        else if (pts.length === 2) L.polyline(live, STYLE_TRACE_OPEN).addTo(shape);
      });
      m.on('dragend', () => { redraw(); changed(); });
    });
  }

  map.on('click', (e) => {
    pts.push({ lat: e.latlng.lat, lon: e.latlng.lng });
    redraw();
    changed();
  });

  // Same zero-size-container trap as renderBuildingMap: size, then frame.
  const frame = () => {
    map.invalidateSize({ animate: false });
    if (pts.length >= 2) {
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.6),
        { maxZoom: 20, animate: false });
    } else {
      map.setView([point.lat, point.lon], 20, { animate: false });
    }
  };
  // Leaflet cannot place markers until the map has a view, so frame first.
  frame();
  redraw();
  requestAnimationFrame(frame);
  setTimeout(frame, 120);

  return {
    map,
    undo() { pts.pop(); redraw(); changed(); },
    clear() { pts = []; redraw(); changed(); },
    destroy() {
      try { map.remove(); } catch { /* already gone */ }
    },
  };
}
