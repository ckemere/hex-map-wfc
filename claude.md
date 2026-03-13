# Hex Map WFC — River System Project Brief

## What this project is
A fork of Felix Turner's procedural hex map generator (WFC-based, Three.js WebGPU).
Original article: https://felixturner.github.io/hex-map-wfc/article/

## What we've done so far
- Added a `slopeBias` parameter (merged to main).
  Multiplies the WFC selection weight of any tile with `highEdges` at collapse 
  time, making terrain more or less mountainous without changing constraint rules.
  Lives in `allParams.roads.slopeBias`, passed through WFCManager into the worker.

## The main goal: a two-pass river system
The original WFC includes river tiles in the solve, which causes three problems:
- Rivers can form loops
- Rivers can flow uphill or cross elevation levels illogically
- Rivers don't reliably terminate in bodies of water

### Development plan

**Step 1 — Remove rivers from WFC (next task)**
Exclude all river tile types from the WFC solve entirely. River tiles are 
identifiable by checking whether any edge in `TILE_LIST[type].edges` equals 
`'river'`. This should be controlled by a new `excludeRivers` boolean option 
passed through from GUI → HexMap → WFCManager → worker. Validate that the map 
generates cleanly without any river tiles.

**Step 2 — Rule-based river placement (second pass)**
After WFC completes, add rivers as a post-processing step using the solved 
elevation data (`globalCells`, each cell has a `level` 0–4). Full design 
decisions documented below.

**Step 3 — Lake generation (third pass)**
Find all `RIVER_END` tiles placed during Step 2 (these mark landlocked basins 
where water had nowhere to go). Flood-fill the surrounding topology to generate 
bodies of water. Not yet designed in detail.

---

## Step 2 design decisions

### 1. Source placement
Noise-weighted selection among high-elevation cells (level 3+). A low-frequency 
noise field (independent of terrain noise) is multiplied by cell elevation to 
produce a source probability. Apply a minimum distance between sources to prevent 
clustering. The `slopeBias` parameter helps ensure there is meaningful highland 
for sources to draw from.

### 2. Flow routing
Greedy downhill routing in cube coordinates. At each cell, evaluate all 6 hex 
neighbours and move to the lowest elevation.

Tiebreaker for flat sections (equal elevation neighbours):
- Primary: momentum — prefer continuing in the current direction of travel
- Secondary: noise jitter — add a small noise offset to effective elevation 
  when comparing neighbours, producing slight meanders

### 3. Confluence handling
Rivers merge. When a river's path reaches a cell already claimed by another 
river, it terminates and joins at that point. Junction tile placement is handled 
during the replacement pass. This produces natural converging river systems 
rather than orphaned segments.

### 4. Tile replacement strategy
Local re-solve. When placing a river tile, run a mini WFC on a small radius 
around the target cell, seeded with the river entry/exit face directions as hard 
constraints. Use noise-weighted tile selection during this local solve, biased 
toward river-compatible tiles. This reuses the existing Local-WFC recovery 
mechanism already present in the codebase.

### 5. River termination
- **Reaches sea or coast** → place `RIVER_INTO_COAST`, terminate. Ideal outcome.
- **Reaches map edge on land** → terminate naturally. Rivers can flow off the 
  edge of the map just as the land does.
- **No valid downhill or flat neighbour** (landlocked basin) → place `RIVER_END` 
  tile and terminate. This tile is a semantic marker for Step 3 lake generation.
- **Exceeds maximum step count** → discard the river silently. This catches 
  routing anomalies on very gentle gradients and is distinct from a genuine basin.

---

## Codebase orientation

- `src/hexmap/HexTileData.js` — all tile definitions. River tiles have at least 
  one edge with value `'river'`. Slope/cliff tiles have `highEdges` array.
- `src/workers/wfc.worker.js` — WFC solver. `tileTypes` option array controls 
  which tiles are eligible for the solve.
- `src/hexmap/WFCManager.js` — orchestrates solves, passes options to worker. 
  `runWfcAttempt` is where per-solve options are assembled.
- `src/hexmap/HexMap.js` — `populateGrid` and `populateAllGrids` are the two 
  solve entry points. `globalCells` is the post-solve Map of all placed tiles, 
  keyed by cube coordinate string, each entry has `type`, `rotation`, `level`.
- `src/GUI.js` — all GUI parameters. Generation-time params go in 
  `allParams.roads`. Visual/shader params go in `allParams.debug`.
- `src/hexmap/HexWFCCore.js` — cube coordinate helpers, adjacency rules.

### River tile names to be aware of
`RIVER_A`, `RIVER_B`, `RIVER_C`, `RIVER_END`, `RIVER_A_SLOPE_LOW`, 
`RIVER_INTO_COAST`, `RIVER_CROSSING_A`, `RIVER_CROSSING_B`

---

## Conventions
- New GUI parameters follow the pattern already established by `slopeBias`
- Always pass new options through the full chain: 
  GUI params → HexMap context → WFCManager → solveWfcAsync options → worker
- Do not re-seed the WFC worker's RNG per solve (breaks determinism)
- Branch naming: `feature/<short-description>`
