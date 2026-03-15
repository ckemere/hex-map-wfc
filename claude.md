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

`src/hexmap/TerrainNoise.js` — `buildTerrainDensity(globalCells, riverCells)`
- **forestDensity**: `max(noiseA, noiseB) × elevationShape × coastFade × (1 + riverAttraction × 0.3)`
- **villageDensity**: `noiseC × elevationShape × coastFade × (1 + riverAttraction × 0.6)`
- Coast fade: suppresses density near coast/water (0→1 over coastRange)
- River attraction: boosts density near rivers (stronger for villages)
- Elevation shaping: forests prefer mid-level, villages prefer flat

`src/hexmap/ForestPlacer.js` — thresholds `forestDensity >= treeThreshold`
`src/hexmap/VillagePlacer.js` — thresholds `villageDensity >= buildingThreshold`,
then picks village centers with `minVillageDistance` spacing and expands each
into a cluster of eligible neighbors.

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
