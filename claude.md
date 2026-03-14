# Hex Map WFC — River System Project Brief

## What this project is
A fork of Felix Turner's procedural hex map generator (WFC-based, Three.js WebGPU).
Original article: https://felixturner.github.io/hex-map-wfc/article/

## What we've done so far
- Added a `slopeBias` parameter (merged to main).
  Multiplies the WFC selection weight of any tile with `highEdges` at collapse
  time, making terrain more or less mountainous without changing constraint rules.
  Lives in `allParams.roads.slopeBias`, passed through WFCManager into the worker.
- Removed river tiles from WFC solve behind an `excludeRivers` option (merged).

## Overall vision: a multi-phase generation pipeline
The original WFC generates terrain, roads, and rivers simultaneously with no
awareness of physical plausibility. We are replacing this with a sequenced
pipeline where each phase respects the output of the previous one:

1. **Terrain** — WFC only. No road tiles, no river tiles.
2. **Rivers** — rule-based second pass using elevation data from phase 1.
3. **Lakes** — flood-fill from RIVER_END markers left by phase 2.
4. **Settlements** — noise + proximity scoring after water features are known.
5. **Roads** — pathfinding between settlements, crossing rivers at valid points.
6. **Decorations** — trees, buildings, waterlilies follow from all prior phases.

---

## Development plan

### Step 1 — Remove rivers from WFC ✅ DONE
River tiles excluded from solve behind `excludeRivers` boolean option.

### Step 2 — Remove roads from WFC (next task)
Remove all road tile types from the WFC solve entirely, the same way rivers
were removed. Road tiles are identifiable by checking whether any edge in
`TILE_LIST[type].edges` equals `'road'`. Add an `excludeRoads` boolean option
following the exact same pattern as `excludeRivers`. Validate that the map
generates cleanly with only terrain tiles (grass, water, coast, slopes, cliffs).

### Step 3 — Rule-based river placement
Post-WFC second pass using solved elevation data. Full design below.

### Step 4 — Lake generation
Flood-fill from RIVER_END tile markers. Not yet designed in detail.

### Step 5 — Settlement placement
Noise + location scoring pass after lakes are known. Design below.

### Step 6 — Road routing
Pathfinding between settlements. Design below.

---

## Step 3: River placement design

### Source placement
Noise-weighted selection among high-elevation cells (level 3+). A low-frequency
noise field (independent of terrain noise) is multiplied by cell elevation to
produce a source probability. Apply a minimum distance between sources to prevent
clustering.

### Flow routing
Greedy downhill routing in cube coordinates. At each cell, evaluate all 6 hex
neighbours and move to the lowest elevation.

Tiebreaker for flat sections:
- Primary: momentum — prefer continuing in the current direction of travel
- Secondary: noise jitter — small noise offset to effective elevation when
  comparing equal neighbours, producing slight meanders

### Confluence handling
Rivers merge. When a routing path reaches a cell already claimed by another
river, it terminates and joins at that point. Junction tile placement is handled
during the replacement pass.

### Tile replacement strategy
Local re-solve. When placing a river tile, run a mini WFC on a small radius
around the target cell seeded with the river entry/exit face directions as hard
constraints, with noise-weighted tile selection biased toward river-compatible
tiles. Reuses the existing Local-WFC recovery mechanism.

### Tileset constraints — IMPORTANT
The router must treat these as hard routing constraints, not tile-placement
problems. Only attempt routes that satisfy all of these:

- **Slope descents**: only possible on E/W axis, only 1-level drops.
  (`RIVER_A_SLOPE_LOW` is the only river slope tile.)
  Two-level drops and non-E/W slope approaches are impassable for rivers.
- **Road crossings**: only possible when river travels E/W AND road also runs
  E/W at that cell. (`RIVER_CROSSING_A` and `RIVER_CROSSING_B` both have river
  on E/W only.) Any other crossing angle is impassable.
- **Coast termination**: `RIVER_INTO_COAST` only accepts river entry from NW.
  A river approaching coast from any other direction cannot use this tile —
  treat as abort rather than broken placement.

### River termination rules
- **Reaches sea or coast from NW** → place `RIVER_INTO_COAST`, terminate.
- **Reaches map edge on land** → terminate naturally, no tile needed.
- **No valid downhill or flat neighbour** (landlocked basin) → place `RIVER_END`
  tile, terminate. This is a semantic marker for Step 4 lake generation.
- **Exceeds maximum step count** → discard river silently. Catches routing
  anomalies, distinct from a genuine basin.

---

## Step 5: Settlement placement design

### Placement scoring
Each candidate flat grass cell is scored by a composite of:

**Strong positive:**
- River-coast boundary (river mouth) — highest possible score, almost always
  generates a settlement. Consider always placing one deterministically at every
  `RIVER_INTO_COAST` tile.
- River adjacency — any flat tile neighbouring a river cell
- Lake shore — flat tile neighbouring a future lake cell

**Moderate positive:**
- Forest edge — boundary between high tree-noise and open land
- Flat low-elevation grass

**Negative:**
- Deep forest interior
- Cliff or slope adjacency
- High elevation (except special fortress/monastery type)

### Settlement types
Type is determined at seed time from location characteristics. Type governs
building weights, count, tree clearing, and road connections:

- **river_mouth_town** — requires river + coast. 8–14 buildings, market and
  church weighted up, roads mandatory, tree clearing.
- **riverside_village** — river adjacent, inland. 4–8 buildings, homes and
  market, road connections, tree clearing.
- **lake_village** — lake shore. Similar to riverside_village.
- **coastal_port** — coast adjacent, no river. Windmills, port buildings, roads.
- **forest_camp** — deep forest noise. 1–3 buildings, no tree clearing, no roads
  or single track out, woodcutter character.
- **hilltop_fortress** — high elevation, cliff adjacent. 1–2 buildings (tower
  weighted), single road out, no tree clearing.

---

## Step 6: Road routing design

### Pathfinding
A* between settlement pairs across the terrain graph. Cost function:
- Flat grass tile: low cost
- Slope tile: higher cost (roads avoid steep terrain)
- Cliff tile: impassable
- River cell: passable only if a valid crossing tile exists for that direction
  (E/W river travel only — see tileset constraints above)
- Water/coast: impassable

### Tile placement
Road tiles placed along found paths, same local re-solve approach as rivers.
Junctions placed where paths branch. Settlement type determines how many
road connections are required.

---

## Codebase orientation

- `src/hexmap/HexTileData.js` — all tile definitions. River tiles have at least
  one edge `'river'`. Road tiles have at least one edge `'road'`. Slope/cliff
  tiles have `highEdges` array.
- `src/workers/wfc.worker.js` — WFC solver. `tileTypes` option array controls
  which tiles are eligible. `excludeRivers` pattern is the model for `excludeRoads`.
- `src/hexmap/WFCManager.js` — orchestrates solves, passes options to worker.
  `runWfcAttempt` is where per-solve options are assembled.
- `src/hexmap/HexMap.js` — `populateGrid` and `populateAllGrids` are the two
  solve entry points. `globalCells` is the post-solve Map of all placed tiles,
  keyed by cube coordinate string, each with `type`, `rotation`, `level`.
- `src/GUI.js` — all GUI parameters. Generation-time params go in
  `allParams.roads`. Visual/shader params go in `allParams.debug`.
- `src/hexmap/Decorations.js` — tree, building, waterlily, bridge placement.
  Currently tied to tile types — will need updating as pipeline evolves.
- `src/hexmap/HexWFCCore.js` — cube coordinate helpers, adjacency rules.

### Tile names to be aware of
**River:** `RIVER_A`, `RIVER_A_CURVY`, `RIVER_B`, `RIVER_D`, `RIVER_E`,
`RIVER_F`, `RIVER_END`, `RIVER_A_SLOPE_LOW`, `RIVER_INTO_COAST`,
`RIVER_CROSSING_A`, `RIVER_CROSSING_B`

**Road:** `ROAD_A`, `ROAD_B`, `ROAD_D`, `ROAD_E`, `ROAD_F`, `ROAD_END`,
`ROAD_A_SLOPE_LOW`, `ROAD_A_SLOPE_HIGH`

---

## Conventions
- New options follow the pattern established by `excludeRivers` and `slopeBias`
- Always pass new options through the full chain:
  GUI → HexMap context → WFCManager → solveWfcAsync options → worker
- Do not re-seed the WFC worker RNG per solve (breaks determinism)
- Branch naming: `feature/<short-description>`
- One PR per step — keep changes reviewable
