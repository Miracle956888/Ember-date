/**
 * Geospatial helpers for the location features.
 *
 * Design notes
 * ------------
 * - We never ship another user's raw coordinates to a client. The API exposes
 *   a *bucketed* distance string ("under 1 km", "4 km away"). `haversineKm` is
 *   server-side only.
 * - "Approximate" privacy mode snaps a position to a coarse grid *before* it is
 *   written, so the database itself never holds the precise point. Snapping to
 *   0.01 deg is ~1.1 km of latitude, which is the resolution Badoo-style
 *   neighbourhood discovery needs without being able to identify a building.
 * - Proximity queries pre-filter on a cheap bounding box + cell key, then do
 *   exact haversine in SQL. That keeps the index useful without PostGIS.
 */

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** Grid size for 'approximate' mode, in degrees (~1.1 km). */
export const APPROX_GRID_DEG = 0.01;

/** Cell size for the geohash-ish bucket key, in degrees (~11 km). */
const CELL_DEG = 0.1;

export function isValidLat(lat) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLng(lng) {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

/** Great-circle distance in kilometres. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Snap a coordinate to the privacy grid. Used for 'approximate' mode so the
 * stored value cannot pinpoint a home address.
 */
export function snapToGrid(lat, lng, grid = APPROX_GRID_DEG) {
  const snap = (v) => Math.round(v / grid) * grid;
  return {
    lat: Number(snap(lat).toFixed(6)),
    lng: Number(snap(lng).toFixed(6))
  };
}

/**
 * Coarse cell key, e.g. "4.81,7.02". Cheap equality/prefix filtering before the
 * exact distance maths runs.
 */
export function cellKey(lat, lng) {
  const q = (v) => (Math.floor(v / CELL_DEG) * CELL_DEG).toFixed(2);
  return `${q(lat)},${q(lng)}`;
}

/**
 * The set of cell keys covering a radius around a point — the cell the point is
 * in plus every neighbour the circle touches. Used as an `IN (...)` pre-filter.
 */
export function cellsWithin(lat, lng, radiusKm) {
  const latSpan = radiusKm / 111;
  const lngSpan = radiusKm / Math.max(1e-6, 111 * Math.cos(lat * DEG));
  const steps = (span) => Math.ceil(span / CELL_DEG);
  const latSteps = Math.min(40, steps(latSpan));
  const lngSteps = Math.min(40, steps(lngSpan));

  const keys = new Set();
  for (let i = -latSteps; i <= latSteps; i += 1) {
    for (let j = -lngSteps; j <= lngSteps; j += 1) {
      const cLat = Math.max(-90, Math.min(90, lat + i * CELL_DEG));
      let cLng = lng + j * CELL_DEG;
      // Wrap the antimeridian so a search near +180 still finds -179.
      if (cLng > 180) cLng -= 360;
      if (cLng < -180) cLng += 360;
      keys.add(cellKey(cLat, cLng));
    }
  }
  return [...keys];
}

/** Bounding box for a radius, for a quick BETWEEN pre-filter. */
export function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / Math.max(1e-6, 111 * Math.cos(lat * DEG));
  return {
    minLat: Math.max(-90, lat - dLat),
    maxLat: Math.min(90, lat + dLat),
    minLng: lng - dLng,
    maxLng: lng + dLng
  };
}

/**
 * Human distance label. Deliberately coarse: exact distances let someone
 * triangulate a position by moving around, so we round hard at short range.
 */
export function distanceLabel(km) {
  if (km === null || km === undefined || !Number.isFinite(km)) return null;
  if (km < 1) return 'under 1 km away';
  if (km < 10) return `${Math.round(km)} km away`;
  if (km < 100) return `${Math.round(km / 5) * 5} km away`;
  return `${Math.round(km / 50) * 50} km away`;
}

/** Short form for tight spaces like deck cards ("2 km", "<1 km"). */
export function shortDistance(km) {
  if (km === null || km === undefined || !Number.isFinite(km)) return null;
  if (km < 1) return '<1 km';
  if (km < 10) return `${Math.round(km)} km`;
  if (km < 100) return `${Math.round(km / 5) * 5} km`;
  return `${Math.round(km / 50) * 50}+ km`;
}

/** Metres label used by "Bumped into" where proximity is the whole point. */
export function proximityLabel(metres) {
  if (!Number.isFinite(metres)) return null;
  if (metres < 100) return 'within 100 m';
  if (metres < 500) return 'within 500 m';
  if (metres < 1000) return 'within 1 km';
  return `about ${Math.round(metres / 1000)} km`;
}

/**
 * SQL fragment computing kilometres between a stored row and a bound point.
 * Parameter order: lat, lat, lng. Kept here so every caller uses identical
 * maths and nobody hand-rolls a variant.
 */
export const DISTANCE_SQL = `(
  6371 * ACOS(
    LEAST(1, GREATEST(-1,
      SIN(RADIANS(?)) * SIN(RADIANS(ul.lat)) +
      COS(RADIANS(?)) * COS(RADIANS(ul.lat)) * COS(RADIANS(ul.lng) - RADIANS(?))
    ))
  )
)`;
