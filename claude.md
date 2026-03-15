# Hex Map WFC — River System Project Brief

## What this project is
A fork of Felix Turner's procedural hex map generator (WFC-based, Three.js WebGPU).
Original article: https://felixturner.github.io/hex-map-wfc/article/

## What we've done so far
- Added a `slopeBias` parameter (merged to main).
  Multiplies the WFC selection weight of any tile with `highEdges` at collapse
  time, making terrain more or less mountainous without changing constraint rules.
  Lives in `allParams.roads.slopeBias`, passed through WFCManager into the worker.
- River and road tiles excluded from WFC by default. GUI toggles
  `includeRiversInWFC` / `includeRoadsInWFC` (default false) let you re-enable
  them for debugging. Rivers are placed post-WFC by RiverRouter; roads will be
  placed post-WFC by a future RoadRouter.

- **BFS-based river routing** (Step 2 complete — routing only, no tile replacement yet).
  `RiverRouter` runs as a post-WFC pass. Routes rivers downhill from high-elevation
  sources to coast/water/map-edge using Dijkstra-style BFS tree expansion.

- **Debug overlay** for river visualisation.
  `RiverDebugOverlay` renders colored hex fills on the terrain: red=source,
  blue=path, magenta=confluence, cyan=coast end, yellow=edge end, orange=basin end.
  Slope tiles shown as green/brown background tint.

## The main goal: multi-pass terrain generation
The original WFC includes river tiles in the solve, which causes three problems:
- Rivers can form loops
- Rivers can flow uphill or cross elevation levels illogically
- Rivers don't reliably terminate in bodies of water

Pipeline phases (run in order after WFC terrain solve):
1. **Terrain** — WFC only. No road tiles, no river tiles. ✅
2. **Rivers** — rule-based second pass using elevation data from phase 1. ✅
3. **Forests** — terrain-shaped noise density, thresholded placement. ✅
4. **Villages** — terrain-shaped noise density, clustered placement. ✅
5. **Lakes** — flood-fill from RIVER_END markers left by phase 2. ⬜
6. **Roads** — pathfinding between settlements, crossing rivers at valid points. ⬜

---

## Development plan

### Step 1 — Remove rivers/roads from WFC ✅ DONE
River and road tiles excluded from solve by default. GUI toggles
`includeRiversInWFC` / `includeRoadsInWFC` re-enable them for debugging.

## Step 2 — River routing algorithm ✅ DONE
Post-WFC second pass using solved elevation data from `globalCells`.

#### Architecture
`RiverRouter` (`src/hexmap/RiverRouter.js`) takes `globalCells` and produces:
- `riverCells`: Map<cubeKey, { type, riverIndex }> — every cell touched by a river
- `rivers`: Array<{ source, path, endType }> — per-river metadata

#### Source placement
Noise-weighted selection among high-elevation cells (level ≥ `minSourceLevel`,
default 2). A hash-based noise field is multiplied by cell elevation to produce a
source weight. Sources are greedily picked highest-weight-first, enforcing
`minSourceDistance` (default 6) between them. Cells near the map edge or with
coast/water/river edges are excluded.

#### Flow routing — BFS tree expansion
Each river expands a Dijkstra-style BFS tree from its source through downhill and
flat neighbors (using a `MinHeap` priority queue):

- **Cost function**: `effectiveElevation + distanceCost + edgePenalty`.
  - `effectiveElevation` = max(neighbor base level, entry edge level) — accounts
    for slopes so rivers don't cross onto the high side of a slope tile.
  - `distanceCost` (default 0.15) — per-step penalty to prefer shorter paths.
  - `edgePenalty` (default 2.0 per missing neighbor) — repels rivers from map edges.
- **Per-river state**: `cameFrom` (parent pointers) and `costSoFar` maps, fresh
  per river. These are the BFS tree — not shared across rivers.
- **`globalOwned`**: shared Map of cells committed by finalized rivers. Only
  written after a river's path is fully traced. Used for confluence detection.

#### Goal detection
The BFS tree stops expanding a branch when it hits:
- **Coast/water tile** → `COAST_END` (preferred goal)
- **Cell in `globalOwned`** from another river → `CONFLUENCE`
- **Cell adjacent to `globalOwned`** from another river → `CONFLUENCE`
  (prevents parallel rivers on flat terrain)
- **Off-map cell** → `EDGE_END`
- No valid neighbors → dead leaf (naturally pruned)

All goals are collected, then the best is selected: coast > confluence > edge,
tiebroken by lowest cost.

**Elevation check applies to all neighbors** including coast/water, preventing
rivers from flowing uphill to high-elevation coast tiles (crater lakes).

#### Path extraction
Trace `cameFrom` pointers from the best goal back to the source. Mark cells
in `riverCells` (for debug overlay) and `globalOwned` (for later rivers).

#### Confluence handling
Rivers route highest-source-first. When river B's BFS tree touches river A's
committed path (either directly or via adjacency), it records a confluence goal
and terminates. This produces natural tributary merging. The adjacency check
ensures rivers never run side-by-side on flat terrain.

#### River termination
- **Reaches coast/water** → `COAST_END`. Ideal outcome.
- **Reaches existing river** → `CONFLUENCE`. Natural tributary merge.
- **Reaches map edge** → `EDGE_END`. River flows off the edge.
- **No reachable goal within `maxExpansion` cells** → `BASIN_END`. Marker for
  Step 3 lake generation.

---

## Step 3 — Tile replacement ✅ DONE

`computeReplacements()` selects the best river tile + rotation for each cell in
the routed path. Uses `selectRiverTile(dirs)` which matches needed river edge
directions against the TILE_LIST. Coast-end cells place RIVER_INTO_COAST
directly — BFS pre-validates mouth compatibility via the `validMouths` map
(checks the 5 non-river edges), so no re-validation is needed at placement time.

---

## Step 4 & 5 — Forest and Village placement ✅ DONE

### Architecture: Terrain-shaped noise
After WFC terrain and river routing, `TerrainNoise.buildTerrainDensity()`
builds per-cell density maps that combine the base simplex noise with terrain
features. The noise IS the terrain — elevation, river proximity, and coast
distance are baked into the density values.

### Noise foundation (`DecorationDefs.js`)
Three independent `ScaledNoise` instances (SimplexNoise remapped from [-1,1]
to [0,1]):
- **globalNoiseA** (freq 0.05) — tree channel A
- **globalNoiseB** (freq 0.05) — tree channel B
- **globalNoiseC** (freq 0.02) — village/building channel

### Shared terrain factors (`TerrainNoise.js`)
Computed per cell before density formulas:

| Factor | Formula | Purpose |
|--------|---------|---------|
| `coastFade` | `distToCoast ≤ coastRange(2) ? distToCoast/coastRange : 1` | Suppress near coast (0→1) |
| `riverAttraction` | `distToRiver ≤ riverRange(4) ? 1 - distToRiver/(riverRange+1) : 0` | Boost near rivers (1→0) |

### Forest density formula
```
baseNoise      = max(noiseA, noiseB)
elevationShape = max(0, 1 - |cell.level - forestIdealLevel(1)| × 0.25)
forestDensity  = min(1, baseNoise × elevationShape × coastFade × (1 + riverAttraction × 0.3))
```
- Two noise channels → overlapping biomes of tree type A and B.
- Elevation decays 25% per level away from ideal (level 1).
- Rivers give a mild 30% boost.

### Forest zone thresholding (`ForestPlacer.js`)
All cells with `forestDensity ≥ treeThreshold (0.5)` are added to the
`forestCells` set. Simple pass — no clustering or spacing logic.

### Tree instance placement (`Decorations.populate()`)
Within forest zones, each cell gets a tree mesh:
1. **Type**: `noiseA ≥ noiseB → type A, else type B`.
2. **Density tier**: `tier = floor(noiseVal × 4)` clamped to 0–3.
   - Tier 0 → `tree_single_{A,B}` (30% chance of variant C/D/E instead)
   - Tier 1 → `trees_{A,B}_small`
   - Tier 2 → `trees_{A,B}_medium`
   - Tier 3 → `trees_{A,B}_large`
3. **Position jitter**: ±0.2 units XZ, scale 1.0–1.2, random Y rotation.
4. **Instance limit**: `MAX_TREES = 100` per grid.

### Village density formula
```
baseNoise      = noiseC
elevationShape = cell.level ≤ villageMaxLevel(1) ? 1 : max(0, 1 - (cell.level - 1) × 0.4)
villageDensity = min(1, baseNoise × elevationShape × coastFade × (1 + riverAttraction × 1.0))
```
- Single noise channel at lower frequency → larger village blobs.
- Elevation drops 40% per level above 1 (stricter than forests).
- Rivers give a strong 100% boost (up to 2× density).

### Village zone creation (`VillagePlacer.js`)
1. Collect cells where `villageDensity ≥ 0.35` **and** not in `forestCells`.
2. Sort candidates by density descending.
3. Greedily pick village centers, enforcing `minVillageDistance = 4` hex.
4. Expand each center to all 6 hex neighbors (radius 1) that are in the
   density map and not forest.

TODO: Prose description of what we would like for villages
Settlement scoring
The settlement placement becomes quite rich when you combine all the factors:
Strong positive signals:
	-	River-coast boundary — where a river meets the sea is historically the single most powerful settlement attractor. Ports, fishing, fresh water and salt water trade all converge there
	-	River adjacency — any flat tile near a river, not just the mouth
	-	Lake shore — same logic as river, fresh water access
Moderate positive signals:
	-	Forest edge — the boundary between forest and open land, not deep forest. Shelter, building materials, hunting, but still farmable land nearby
	-	Flat low-elevation grass — easy to build on and farm
Negative signals:
	-	Deep forest — occasional settlements but rare, and they'd feel like isolated woodcutter camps or hermitages rather than villages
	-	Cliff or slope adjacency — defensible occasionally but generally avoided
	-	High elevation — rare, maybe a fortress or monastery as a special case
The composite score for each candidate cell would multiply these factors together, giving you a probability surface across the whole map. You then sample from that surface with some noise to avoid all settlements landing on identical optimal spots.

With the current decoration system you actually have more to work with than you might think. Settlement character comes from which buildings are placed and what surrounds them, and both of those are already data-driven through BuildingDefs weights and the tree placement system.
Right now every settlement draws from the same BuildingDefs weighted pool. The simplest change is to define settlement type profiles — each one just a different weighting table over the existing building meshes. For example:
  - Riverside village — higher weight on building_market, building_home, bridges nearby, no trees within the settlement boundary
  - Forest camp — higher weight on smaller structures, trees allowed right up to building edges, lower building count overall
  - Coastal port — windmills, the existing port/dock logic already biased toward coast, boats if they exist in the mesh set
  - River mouth town — the richest settlement, highest building count, market and church weighted up, road connections mandatory

None of this requires new 3D assets. It's purely about how you weight the existing pool and what rules govern tree clearance around buildings.

   

### Building instance placement (`Decorations.populateBuildings()`)
Within village zones, buildings are placed in priority order:

1. **Road dead-ends** — building faces the road exit direction.
2. **Village noise candidates** — cells in the `villageCells` zone.
3. **Coast windmills** — 35% chance on coast-adjacent grass (level 0).
   Three-part composite: base + top (y+0.685) + fan (y+0.957, z+0.332)
   with 4-second rotation animation.
4. **Shipyard** — 25% chance on COAST_A tiles, max 1 per grid.
5. **Rare buildings** — 50% chance on high grass (level 2+), max 1 per grid.
   Weighted: henge (2), mine (1), fort (1).

Building mesh selection uses weighted random pick:
```
building_home_A_yellow  weight 15   (most common)
building_home_B_yellow  weight 6
building_well_yellow    weight 3
building_church_yellow  weight 2    (unique — max 1)
building_tower_A_yellow weight 2    (50% chance of tower top)
building_market_yellow  weight 2    (unique — max 1)
building_blacksmith     weight 1    (unique — max 1)
building_townhall       weight 1
```
Position jitter ±0.3 units XZ, random Y rotation. `MAX_BUILDINGS = 40` per grid.

### Key thresholds summary

| Parameter | Value | File |
|-----------|-------|------|
| Tree noise freq | 0.05 | DecorationDefs.js |
| Building noise freq | 0.02 | DecorationDefs.js |
| Forest zone threshold | 0.5 | ForestPlacer.js |
| Village zone threshold | 0.35 | VillagePlacer.js |
| River influence range | 4 hex | TerrainNoise.js |
| Coast suppression range | 2 hex | TerrainNoise.js |
| Forest ideal level | 1 | TerrainNoise.js |
| Village max level | 1 | TerrainNoise.js |
| Min village distance | 4 hex | VillagePlacer.js |
| Village cluster radius | 1 hex | VillagePlacer.js |
| Max trees per grid | 100 | DecorationDefs.js |
| Max buildings per grid | 40 | DecorationDefs.js |

### Pipeline
`routeRivers()` → `_placeZones()`:
1. `buildTerrainDensity()` — noise × terrain → per-cell density maps
2. `ForestPlacer.place()` — threshold → `forestCells` Set
3. `VillagePlacer.place()` — threshold + cluster → `villageCells` Set
4. `_repopulateDecorationsWithZones()` — passes zone maps through HexGrid
   into Decorations for guided tree/building placement

### Decoration integration
During auto-build, `populateFromCubeResults` defers decorations
(`deferDecorations: true`). After the full pipeline completes,
`_repopulateDecorationsWithZones()` populates all grids with zone
awareness. `Decorations.populate()` places trees only in forest zones;
`populateBuildings()` places buildings only in village zones.

---

## Codebase orientation

- `src/hexmap/HexTileData.js` — all tile definitions. River tiles have at least
  one edge `'river'`. Road tiles have at least one edge `'road'`. Slope/cliff
  tiles have `highEdges` array.
- `src/workers/wfc.worker.js` — WFC solver. `tileTypes` option array controls
  which tiles are eligible.
- `src/hexmap/WFCManager.js` — orchestrates solves, passes options to worker.
  `runWfcAttempt` is where per-solve options are assembled.
  `getDefaultTileTypes({ excludeRivers, excludeRoads })` filters tile types.
- `src/hexmap/HexMap.js` — `populateGrid` and `populateAllGrids` are the two
  solve entry points. `globalCells` is the post-solve Map of all placed tiles,
  keyed by cube coordinate string, each entry has `type`, `rotation`, `level`.
  After WFC, calls `routeRivers()` → `_placeZones()` which runs
  RiverRouter, builds terrain-shaped density, and places forest/village zones.
- `src/hexmap/RiverRouter.js` — BFS-based river routing. Exports `RiverRouter`
  class and `RiverCellType` enum. `computeReplacements()` returns direct
  tile replacements for the entire river path including coast mouths.
- `src/hexmap/TerrainNoise.js` — `buildTerrainDensity()` builds per-cell
  density maps combining simplex noise with terrain features (elevation,
  river proximity, coast distance).
- `src/hexmap/ForestPlacer.js` — thresholds forest density → `Set<cubeKey>`.
- `src/hexmap/VillagePlacer.js` — thresholds village density + clusters.
- `src/hexmap/RiverDebugOverlay.js` — debug visualisation of routed rivers.
  Colored hex fills rendered as a Three.js mesh overlay.
- `src/hexmap/HexWFCCore.js` — cube coordinate helpers (`cubeKey`, `CUBE_DIRS`,
  `cubeDistance`), adjacency rules, `getEdgeLevel` for slope-aware edge levels.
- `src/GUI.js` — all GUI parameters. Generation-time params go in
  `allParams.roads`. Visual/shader params go in `allParams.debug`.
  `includeRiversInWFC` / `includeRoadsInWFC` (default false) control whether
  river/road tiles are included in the initial WFC solve.

### River tile names to be aware of
`RIVER_A`, `RIVER_B`, `RIVER_C`, `RIVER_END`, `RIVER_A_SLOPE_LOW`,
`RIVER_INTO_COAST`, `RIVER_CROSSING_A`, `RIVER_CROSSING_B`

### Road Tile names to be aware of
**Road:** `ROAD_A`, `ROAD_B`, `ROAD_D`, `ROAD_E`, `ROAD_F`, `ROAD_END`,
`ROAD_A_SLOPE_LOW`, `ROAD_A_SLOPE_HIGH`

---

## Conventions
- New options follow the pattern established by `includeRiversInWFC` and `slopeBias`
- Always pass new options through the full chain:
  GUI → HexMap context → WFCManager → solveWfcAsync options → worker
- Do not re-seed the WFC worker RNG per solve (breaks determinism)
- New pipeline phases live in dedicated files (e.g. `src/hexmap/RiverRouter.js`)
  rather than being added to HexMap.js directly
- Branch naming: `feature/<short-description>`
- Build with `npx vite build` — no test suite currently
- One PR per step — keep changes reviewable
