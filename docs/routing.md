# River & Road Routing

Rivers and roads are placed **after** Wave Function Collapse (WFC) completes.
WFC solves terrain (grass, water, coast, slopes) without any river or road
tiles. The routers then carve paths through the solved terrain and swap in the
appropriate river/road tiles.

```
WFC solve → Rivers → Forests / Villages → Roads
```

---

## Hex Directions & Bitmasks

Each hex cell has six edges numbered **0–5** going clockwise from northeast:

```
        ___
       / 0 \        0 = NE    Bit 0 = 0b000001
      /5   1\       1 = E     Bit 1 = 0b000010
     |       |      2 = SE    Bit 2 = 0b000100
      \4   2/       3 = SW    Bit 3 = 0b001000
       \_3_/        4 = W     Bit 4 = 0b010000
                    5 = NW    Bit 5 = 0b100000
```

Any combination of river (or road) edges on a tile can be encoded as a 6-bit
number. For example, a straight E–W river has edges {1, 4} → `0b010010` = 18.

### Tile Lookup Tables

At module load, each router builds a **64-entry lookup table** that maps every
possible bitmask to `{ type, rotation }` or `null`:

```js
const RIVER_TILE_LOOKUP = buildTileLookup([
  { type: TileType.RIVER_END, dirs: [4] },        // 1 edge
  { type: TileType.RIVER_A,   dirs: [1, 4] },     // 2 edges, straight
  { type: TileType.RIVER_B,   dirs: [0, 4] },     // 2 edges, 120° curve
  { type: TileType.RIVER_D,   dirs: [0, 2, 4] },  // 3 edges, Y-junction
  ...
])
```

`buildTileLookup` (in `RouteUtils.js`) rotates each template through all six
orientations and records the first match for each bitmask. Tile selection then
becomes a single array index: `RIVER_TILE_LOOKUP[mask]`.

This same table is also used for **confluence validation** — when a new river
wants to merge into an existing river cell, we OR the masks together and check
whether the lookup returns a valid tile.

---

## River Tiles

The following tiles are available for rivers (shown in their **unrotated**
orientation, rotation 0):

### 2-Edge Tiles

<!-- IMAGE: hex_river_A.png — straight river flowing E↔W -->

| Tile | Mesh | River Edges | Bitmask | Description |
|------|------|-------------|---------|-------------|
| `RIVER_A` | `hex_river_A` | E, W | `0b010010` (18) | Straight river, 180° |
| `RIVER_A_CURVY` | `hex_river_A_curvy` | E, W | `0b010010` (18) | Curvy straight variant (randomly chosen) |
| `RIVER_B` | `hex_river_B` | NE, W | `0b010001` (17) | Gentle 120° curve |

<!-- IMAGE: side-by-side of hex_river_A, hex_river_A_curvy, hex_river_B -->

### 3-Edge Tiles (Confluences)

| Tile | Mesh | River Edges | Bitmask | Description |
|------|------|-------------|---------|-------------|
| `RIVER_D` | `hex_river_D` | NE, SE, W | `0b010101` (21) | Even Y-junction, 120° spacing |
| `RIVER_E` | `hex_river_E` | NE, E, W | `0b010011` (19) | Asymmetric T, two adjacent + opposite |
| `RIVER_F` | `hex_river_F` | E, SE, W | `0b010110` (22) | Asymmetric T, two adjacent + opposite |

<!-- IMAGE: side-by-side of hex_river_D, hex_river_E, hex_river_F -->

### Special Tiles

| Tile | Mesh | River Edges | Description |
|------|------|-------------|-------------|
| `RIVER_END` | `river_end` | W | Dead end / spring |
| `RIVER_INTO_COAST` | `river_coast` | NW (river), NE+W (coast), E+SE+SW (water) | River mouth entering coast |
| `RIVER_A_SLOPE_LOW` | `river_slope_low` | E, W | Straight river on a 1-level slope |

<!-- IMAGE: river_end, river_coast, river_slope_low -->

### Crossing Tiles (River + Road)

| Tile | Mesh | River Edges | Road Edges | Description |
|------|------|-------------|------------|-------------|
| `RIVER_CROSSING_A` | `hex_river_crossing_A` | E, W | SE, NW | River straight, road at +60° |
| `RIVER_CROSSING_B` | `hex_river_crossing_B` | E, W | NE, SW | River straight, road at −60° |

<!-- IMAGE: hex_river_crossing_A, hex_river_crossing_B -->

---

## Road Tiles

Road tiles mirror the river tile set structurally — same edge geometries, just
with `'road'` edges instead of `'river'`.

| Tile | Mesh | Road Edges | Bitmask | Description |
|------|------|------------|---------|-------------|
| `ROAD_END` | `hex_road_M` | W | `0b010000` (16) | Dead end |
| `ROAD_A` | `hex_road_A` | E, W | `0b010010` (18) | Straight, 180° |
| `ROAD_B` | `hex_road_B` | NE, W | `0b010001` (17) | 120° curve |
| `ROAD_D` | `hex_road_D` | NE, SE, W | `0b010101` (21) | Even T-junction |
| `ROAD_E` | `hex_road_E` | NE, E, W | `0b010011` (19) | Asymmetric T |
| `ROAD_F` | `hex_road_F` | E, SE, W | `0b010110` (22) | Asymmetric T |
| `ROAD_A_SLOPE_LOW` | `hex_road_A_sloped_low` | E, W | — | Straight on 1-level slope |
| `ROAD_A_SLOPE_HIGH` | `hex_road_A_sloped_high` | E, W | — | Straight on 2-level slope |

<!-- IMAGE: hex_road_A, hex_road_B, hex_road_D showing the parallel to river tiles -->

### Direction Constraints

Because no 60° tile exists for either rivers or roads, when a path enters a
cell from direction **e**, it can only exit to:

```
    (e+2) % 6   — 120° bend  (RIVER_B / ROAD_B)
    (e+3) % 6   — 180° straight (RIVER_A / ROAD_A)
    (e+4) % 6   — 120° bend  (RIVER_B / ROAD_B)
```

Source cells and road terminals (no entry direction) may exit in any of the six
directions.

---

## River Router

**File:** `src/hexmap/RiverRouter.js`

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minSourceLevel` | 2 | Minimum cell elevation to place a river source |
| `minSourceDistance` | 6 | Minimum hex distance between any two sources |
| `noiseFreq` | 0.08 | Frequency of the hash-based noise used to weight source candidates |
| `maxExpansion` | 600 | Maximum cells expanded per river's BFS pass |
| `distanceCost` | 0.15 | Per-step cost added during BFS (favors shorter paths) |
| `edgePenalty` | 2.0 | Cost added per missing neighbor (steers rivers away from map edges) |

### Algorithm

#### 1. Pre-compute valid river mouths

Before any routing, scan every coast/water cell and test all six entry
directions for `RIVER_INTO_COAST` placement. This builds a
`Map<cubeKey, Set<entryDir>>` so the BFS can check mouth validity with a
single map lookup.

#### 2. Select sources

Filter `globalCells` for candidates at elevation ≥ `minSourceLevel` that have
no water, coast, or river edges and are not on the map edge. Weight each
candidate by `elevation × coordNoise(q, r)` and greedily pick the
highest-weighted candidates, enforcing `minSourceDistance` between them.

#### 3. Route each river (BFS / Dijkstra)

For each source, expand a priority-queue BFS (Dijkstra) outward. The cost
function at each step is:

```
stepCost = max(neighborBaseLevel, entryEdgeLevel)
         + distanceCost
         + edgePenalty × missingNeighborCount
```

**Elevation constraints** prevent rivers from flowing uphill:
- The exit edge of the current cell must not be higher than its entry edge
  (no uphill *through* a slope tile).
- The entry edge of the neighbor must not be higher than the exit edge of the
  current cell (no uphill *into* the next tile).

**Goal types** (in priority order):

| Priority | Goal | Condition |
|----------|------|-----------|
| 0 (best) | Coast | Neighbor is coast/water and is a pre-computed valid mouth |
| 1 | Confluence | Neighbor belongs to a previously committed river and adding our direction still produces a valid tile (checked via `RIVER_TILE_LOOKUP`) |
| 2 | Map edge | Neighbor cell doesn't exist (off-map) |

When the BFS reaches a goal, it doesn't stop — all goals found during
expansion are collected, then sorted by priority and cost. The best goal is
selected and parent pointers are traced back to the source.

**Adjacency confluence:** if a candidate cell is adjacent to (but not on) an
existing river, the router extends the path *through* that cell to land the
confluence junction on the existing river. This prevents rivers from running
side-by-side without merging.

#### 4. Commit paths

Each routed path is recorded in:
- `riverCells` — `Map<cubeKey, { type, riverIndex }>` for debug overlay
- `globalOwned` — shared map so later rivers detect confluences
- `globalDirs` — per-cell 6-bit direction bitmask for confluence validation

#### 5. Tag slope cells

A post-pass walks each path and compares effective elevation between
consecutive cells. Cells where elevation drops are tagged `SLOPE` for the
debug overlay.

#### 6. Compute tile replacements

For each cell, the accumulated direction bitmask is looked up in
`RIVER_TILE_LOOKUP` to select the tile type and rotation. Special cases:
- **Coast-end cells** → `RIVER_INTO_COAST` with rotation derived from the
  single river direction.
- **Slope cells** (levelIncrement = 1, straight river aligned with slope axis)
  → `RIVER_A_SLOPE_LOW` preserving the original slope rotation.
- **Straight rivers** → randomly `RIVER_A` or `RIVER_A_CURVY` (50/50).

---

## Road Router

**File:** `src/hexmap/RoadRouter.js`

Roads are routed **after** rivers, forests, and villages are placed. The router
connects village clusters via a minimum spanning tree, then selects tiles.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minTerminalDistance` | 3 | Minimum hex distance between road terminals |
| `maxExpansion` | 1200 | Maximum cells expanded per Dijkstra pass |
| `edgePenalty` | 3.0 | Cost per missing neighbor (steers roads away from map edges) |
| `riverPenalty` | 8.0 | Cost for crossing a river without a crossing tile |
| `crossingReward` | 0.5 | Reduced cost when a road uses an existing crossing tile |
| `maxTerminals` | 20 | Maximum number of road terminals (scaled by road density) |
| `adjacencyPenalty` | 4.0 | Cost for stepping adjacent to an already-committed road |

### Algorithm

#### Phase 1 — Terminal selection

1. **Cluster villages** by flood-fill (cells within distance 2 are grouped).
2. Build a **village density field**: for each cell, count village cells within
   radius 2 (weighted by proximity).
3. Score candidates by density + noise. Greedily select one terminal per
   cluster, enforcing `minTerminalDistance`. A second pass relaxes distance to
   2 for any cluster that still lacks a terminal.

#### Phase 2 — Dijkstra expansion

Run a full Dijkstra from each terminal. When the frontier reaches another
terminal, record a candidate edge (source, destination, cost, path). The
expansion continues past found terminals to discover all reachable ones.

**Cost function:**

| Condition | Step Cost |
|-----------|-----------|
| Normal cell | 1.0 |
| River crossing tile | `crossingReward` (0.5) |
| Adjacent to another terminal | +6.0 |
| Adjacent to map edge | +`edgePenalty` × edge count |

**Traversal constraints:**
- Water and coast cells are impassable.
- River cells are only crossable at straight rivers (`RIVER_A` / `RIVER_A_CURVY`)
  where the road axis differs from the river axis.
- Slope tiles only allow roads straight across the slope axis (E–W unrotated,
  rotated by the tile's rotation).
- Edge levels must match between adjacent cells (no cliff crossings).

#### Phase 3 — Kruskal's MST

Deduplicate candidate edges (keep cheapest per terminal pair), sort by cost,
and run Kruskal's algorithm with union-find to produce a minimum spanning tree.

#### Phase 4 — Degree-2 augmentation

For each leaf terminal (degree 1 in the MST), find its cheapest non-MST
connection and add it. This ensures most terminals have at least two road
connections, creating small loops that make the network feel more natural.

#### Phase 5 — Re-route with merging

Re-route each selected edge in cost order using a shared `globalOwned` set.
The cost function now rewards merging into existing road cells (cost 0.2) and
penalizes running parallel to them (`adjacencyPenalty`). This encourages roads
to share segments rather than running side-by-side.

#### Phase 6 — Commit paths & classify cells

Walk all paths and accumulate per-cell direction bitmasks in `roadEdges`.
Classify each cell:

| Type | Condition |
|------|-----------|
| `TERMINAL` | Selected terminal with 2+ directions |
| `ROAD_END` | Terminal with exactly 1 direction |
| `JUNCTION` | Non-terminal with 3+ directions |
| `PATH` | Everything else |

#### Phase 7 — Compute tile replacements

For each cell, look up the bitmask in `ROAD_TILE_LOOKUP`. Special cases:
- **River crossing cells** → `RIVER_CROSSING_A` or `RIVER_CROSSING_B`,
  preserving the river tile's rotation.
- **Slope cells** → `ROAD_A_SLOPE_LOW` or `ROAD_A_SLOPE_HIGH`, preserving
  the original slope rotation.

---

## Shared Utilities

**File:** `src/hexmap/RouteUtils.js`

| Export | Description |
|--------|-------------|
| `MinHeap` | Binary min-heap priority queue ordered by `.cost` |
| `dirSetToMask(dirs)` | Converts an iterable of direction indices (0–5) to a 6-bit number |
| `buildTileLookup(templates)` | Builds a 64-entry `Array<{type, rotation} \| null>` from tile templates |

---

## Debug Overlays

Both routers have companion debug overlays that color-code cells by type:

### River Debug Colors (`RiverDebugOverlay.js`)

| Cell Type | Color |
|-----------|-------|
| Source | Red `#ff3333` |
| Path | Blue `#3388ff` |
| Confluence | Magenta `#ff33ff` |
| Coast End | Cyan `#33ffcc` |
| Edge End | Yellow `#ffcc33` |
| Basin End | Orange `#ff8833` |
| Slope | Green `#33ff66` |
| Slope Missing | Bright Red `#ff0033` |

### Road Debug Colors (`RoadDebugOverlay.js`)

| Cell Type | Color |
|-----------|-------|
| Terminal | Green |
| Path | Yellow |
| Junction | Magenta |
| Road End | Red |
