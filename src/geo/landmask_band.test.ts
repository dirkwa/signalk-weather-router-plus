import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandMask } from './landmask';
import type { ShapePolygon } from './shapefile';

function rect(recordNumber: number, lon0: number, lat0: number, lon1: number, lat1: number): ShapePolygon {
  const c = [lon0, lat0, lon1, lat0, lon1, lat1, lon0, lat1, lon0, lat0];
  return {
    recordNumber,
    minLon: lon0,
    minLat: lat0,
    maxLon: lon1,
    maxLat: lat1,
    rings: [{ coords: Float64Array.from(c), minLon: lon0, minLat: lat0, maxLon: lon1, maxLat: lat1 }],
  };
}

// A 4° × 4° world at 0.01° (1.1 km cells) with two islets: one inside the band along the route, one far outside it.
// The band (1° × 1°) drawn again at 0.002° in tiles small enough to need several of them.
const WORLD = { west: -2, south: -2, east: 2, north: 2 };
const BAND = { west: -0.5, south: -0.5, east: 0.5, north: 0.5 };
const islets = [rect(1, 0.1, 0.1, 0.104, 0.104), rect(2, 1.5, 1.5, 1.504, 1.504)];

test('refineTiled: a band wider than one patch is drawn as a row of patches that answer like a single fine raster', () => {
  const m = LandMask.fromPolygons(islets, WORLD, 0.01);
  // 1° at 0.002° is 500 × 500 = 250,000 cells; a 60,000-cell patch limit forces about 9 tiles.
  const patches = m.refineTiled(BAND, 0.002, 60_000);
  assert.ok(patches.length >= 4, `${patches.length} patches`);
  assert.ok(patches.every(p => Math.abs(p.resolutionDeg - 0.002) < 1e-12 && p.nx * p.ny <= 60_000));
  // The patches cover the band and nothing else.
  for (const p of patches)
    assert.ok(
      p.bbox.west >= BAND.west - 1e-9 &&
        p.bbox.east <= BAND.east + 1e-9 &&
        p.bbox.south >= BAND.south - 1e-9 &&
        p.bbox.north <= BAND.north + 1e-9
    );
  // Inside the band the tiled mask answers as one fine mask over the band would, at points across every tile.
  const fine = LandMask.fromPolygons(islets, BAND, 0.002);
  for (let lat = -0.49; lat < 0.5; lat += 0.07)
    for (let lon = -0.49; lon < 0.5; lon += 0.07) assert.equal(m.isLand(lon, lat), fine.isLand(lon, lat), `${lon}, ${lat}`);
  // The islet in the band is 0.004° across: at 1.1 km cells it was a 3 × 3 land block; at 0.002° it is drawn to its size.
  assert.equal(m.isLand(0.102, 0.102), true);
  assert.equal(m.isLand(0.112, 0.102), false, 'water 900 m off the islet, which the coarse cells called land');
  // Outside the band the base raster still answers (coarse: the far islet's cell and its neighbours are land).
  assert.equal(m.isLand(1.502, 1.502), true);
  assert.equal(m.isLand(1.0, 1.0), false);
  assert.equal(m.resolutionAt(0, 0), 0.002);
  assert.equal(m.resolutionAt(1, 1), 0.01);
});

test('refineBand: the band gets the cell size its own box would get from the budget; nothing when that is no finer', () => {
  const m = LandMask.fromPolygons(islets, WORLD, 0.01);
  // A budget that gives a 1° box (1.2° with the raster's pad) 0.002° cells (360 k) but not 0.001° (1.44 M).
  const r = m.refineBand(BAND, 400_000);
  assert.ok(r && Math.abs(r.resolutionDeg - 0.002) < 1e-12, JSON.stringify(r));
  assert.equal(m.resolutionAt(0, 0), 0.002);
  // A band whose own size is the mask's: nothing to draw.
  const coarse = LandMask.fromPolygons(islets, WORLD, 0.002);
  assert.equal(coarse.refineBand(BAND, 400_000), null);
  assert.equal(coarse.patches.length, 0);
});

test('chooseResolution keeps every box within the cell budget, a world at the 120° × 90° limit included', () => {
  const budget = 25_000_000;
  for (const box of [
    { west: -1, south: -1, east: 1, north: 1 },
    { west: -70.74, south: 22.29, east: -32.14, north: 59.29 },
    { west: -100, south: 0, east: 20, north: 90 },
    { west: -180, south: -90, east: 180, north: 90 },
  ]) {
    const r = LandMask.chooseResolution(box, budget);
    const w = Math.min(360, box.east - box.west + 0.2);
    const h = Math.min(180, box.north - box.south + 0.2);
    assert.ok(
      Math.ceil(w / r) * Math.ceil(h / r) <= budget,
      `${JSON.stringify(box)}: ${r}° gives ${Math.ceil(w / r) * Math.ceil(h / r)} cells`
    );
  }
  // A 120° × 90° world: 0.01° would be 108 M cells; 0.02° is 27 M; 0.05° fits.
  assert.equal(LandMask.chooseResolution({ west: -100, south: 0, east: 20, north: 90 }, budget), 0.05);
  // Small boxes are as before.
  assert.equal(LandMask.chooseResolution({ west: -1, south: -1, east: 1, north: 1 }, budget), 0.0005);
});

test('refineTiled on a buffered mask keeps the buffer in every tile', () => {
  const m = LandMask.fromPolygons(islets, WORLD, 0.01).withBuffer(300);
  const patches = m.refineTiled(BAND, 0.002, 60_000);
  assert.ok(patches.length >= 4);
  // 250 m off the islet is inside the 300 m buffer: land; 600 m off is water.
  assert.equal(m.isLand(0.104 + 250 / 111_195, 0.102), true);
  assert.equal(m.isLand(0.104 + 600 / 111_195, 0.102), false);
});
