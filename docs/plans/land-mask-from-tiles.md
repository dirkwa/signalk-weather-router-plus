# Plan: a route's land mask without the world's polygons

Status: **built** 2026-11-01 (the change below as written; `rawraster.ts`
now exports `drawRasterFromTiles`, the bytes and their dimensions, and
`LandMask.fromTiles` wraps them for the map's land layer and the water-grid
build). The before measurements are in the table below and in
`~/pr91-review/maskmem.js` on brain; the after measurements follow in the
PR. Raised by the PR #91 review
(`src/engine/corridor.ts:819`, 2026-11-01 02:53Z): the search's world is now
as wide as the heading sweep can reach (`worldBox`), the raster's cell
budget holds for any world (`LandMask.chooseResolution`, 2026-11-01), but
the coastline polygons the mask keeps for its exact tests are not bounded
by anything.

## Measured (brain, 2026-11-01, `~/pr91-review/polymem.js`, GSHHG full resolution, the deployed code)

`CoastTiles.read(box)` for the boxes a route builds its mask over:

| box | polygons | coordinate arrays | process RSS after the read |
|---|---|---|---|
| Halifax approaches → Lunenburg, 2.7° × 2.2° | 450 | 0.5 MB | +1 MB |
| Placentia Bay leg, Normal effort world, 25° × 27° | 4,286 | 3.9 MB | +9 MB |
| Placentia Bay leg, Maximum effort world, 38.6° × 37° | 9,168 | 8.2 MB | +14 MB |
| a world at the 120° × 90° limit (a transatlantic leg at Maximum) | 109,963 | 71.7 MB | +269 MB |

The same world's raster after the budget fix: 4.3 M cells at 0.05°, 4 MB,
twice with the land buffer. So at the limit the polygons are the memory,
not the raster. The route worker and every chart-mesh child process that
builds land for a box (`mesh-waters`, `mesh-exit`, `mesh-transfer`) pay it.

## What the pieces are kept for (`src/geo/landmask.ts`)

`LandMask.fromCoastline` calls `coast.read(padded)` and the constructor keeps
the result in `shapes`, sorted by level. They serve:

1. the raster: `rasterize` (fill pass, then the conservative boundary pass);
2. the band's finer patches: `refine` and `refineTiled` filter `shapes` by
   latitude and call `rasterStreamed` over them (with the buffer's margin
   when the mask keeps one);
3. the exact tests: `isLandExact` → `isLandPolygons` (deepest level holding
   the point) and `shoreWithin` (the buffer); `legCrossesLandExact` (every
   ring's real edges against the leg's pieces, with the buffer distance);
   `clearAlong` through them; `nearestExactWater` / `waterAround`
   (`corridor.ts`) through `isLandExact` and `shoreWithin`;
   `hasPolygons` gates all of this.

Each exact test walks every polygon of the mask with a bounding-box reject
per shape and per ring: at the limit 110,000 shapes per leg tested, along a
route of hundreds of legs, in the search's final validation, the smoother,
the polish and the layout.

## What exists already

- `src/geo/coasttiles.ts`: the coastline cut into 0.5° tiles on disk; per
  thread an LRU cache of decoded tiles, `COAST_TILE_CACHE_BYTES` = 24 MB
  (a full-resolution tile is at most a few hundred kB); `forEach(box, fn)`
  streams the tiles' pieces; `containsPoint(lon, lat)` is the exact point
  test from one tile.
- `src/geo/rawraster.ts`: `rasterFromTiles(coast, bbox, res, opts)` draws
  the conservative raster from the tiles' bytes with no object per piece,
  "LandMask.rasterizeShape's, fillShape's and markEdgeCells's arithmetic,
  step for step" (its own words), compared against the decoded path in
  `landcache.test.ts`. Written for the map's land layer, where a world view
  held 18 MB against 381 MB decoded. It takes `nx`/`ny` and `edgeCells`.

## The change

All in `src/geo/landmask.ts`; the callers (`plugin/worker/landgrid.ts`,
`cli.ts`, the mesh child tasks through `landMaskFor` or `fromCoastline`)
keep their calls and get the same answers.

1. **A mask from a coastline holds the raster and the tile store, not the
   pieces.** `fromCoastline` draws the world raster with `rasterFromTiles`
   over the padded box and keeps `coast` (a `CoastTiles`) in a new field
   `tiles`; `shapes` stays empty for it. `withBuffer` is unchanged (it
   dilates the raster). `fromPolygons` and `rasterStreamed` keep `shapes`
   as now (the tests, the water-grid build).
2. **The band's patches come from the tiles.** `refine` draws its patch
   (and the buffer margin around it) with `rasterFromTiles` over the patch
   box when the mask has `tiles`, from `shapes` as now when it has those.
   `refineTiled` and `refineBand` are unchanged.
3. **The exact tests read the tiles they touch.** A private
   `piecesNear(box)` yields the pieces of the tiles meeting `box`, from
   `shapes` (filtered as now) or from `tiles.forEach(box, …)`; the tile
   cache serves repeats. `isLandPolygons` uses `tiles.containsPoint` when
   it has tiles; `shoreWithin` asks for the point's box grown by the
   distance; `legCrossesLandExact` for the leg's box grown by the buffer.
   The per-ring arithmetic (`segmentsTouch`, `segmentsWithinM`,
   `pointSegmentM`, the `real` and `whole` handling) is untouched; the
   tiles' pieces are the records' parts inside each tile, so a leg's box
   meets every piece that can touch the leg.
4. `hasPolygons` becomes "has exact geometry": `shapes.length > 0 ||
   tiles !== null`. The three places that read `shapes.length` directly
   (`isLandExact`, `legCrossesLandExact`) use it.
5. The route worker's one-entry mask cache (`landgrid.ts`) then holds a
   raster only; nothing else changes there.

Memory per thread after: the raster (within the cell budget), the band's
patches, and the tile cache, 24 MB at most, whatever the world's size.

## Tests

- `landmask_band.test.ts` / a new `landmask_tiles.test.ts`: a mask from a
  synthetic tile store (as `corridor.test.ts` builds one) against the same
  mask built from the decoded polygons: identical raster, identical
  patches, identical answers from the four exact tests and `clearAlong`
  at points and legs across tile borders, with and without a buffer.
- The existing tests on `fromPolygons` masks are unchanged.
- `golden.test.ts` builds from polygons: unchanged by construction.

## Measured before and after (brain, same forecast cycle)

1. The three usual legs through the plugin (`~/pr91-review/after.js`):
   route, wall time, the route worker's memory from the status.
2. The harness Maximum world (`margin.js`, `rss 139 → 529 MB` today).
3. A transatlantic leg at Maximum in the harness without a forecast: the
   case that reads 110,000 polygons today (+269 MB).
4. One chart-mesh leg (Cape Cod Canal replay), since the mesh children build
   land the same way.

## Risks

- Exact tests that touch many tiles in one call (`legCrossesLandExact` on
  a long smoother shortcut): the pieces come from the cache or disk per
  call; measured in 1–3 above. The tile cache is per thread, 24 MB, already
  shared with the snap of the route's ends.
- A tile border exactly under a point: `containsPoint` decides by the same
  half-open rule the whole record uses (its own comment); the raster and
  the leg test are unaffected.

## Not in this plan

The forecast window and the 1/3° currents fallback on a world at the
120° × 90° limit (noted 2026-11-01); the mesh children's own tile caches
(one each, 24 MB at most).
