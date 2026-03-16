# Field Decorations — Design Plan

## Goal
Add wheat fields and plowed fields as full-tile decorations on grass tiles near villages and roads.

---

## Key Data Structures

### Tile Definition (`HexTileData.js`)
```js
TILE_LIST[index] = {
  name: 'GRASS',
  mesh: 'hex_grass',           // GLB mesh name
  edges: { NE, E, SE, SW, W, NW },  // each: 'grass'|'road'|'river'|'water'|'coast'
  weight: 500,                 // WFC selection weight
  highEdges?: ['NE','E','SE'], // which edges are uphill (slopes only)
  levelIncrement?: 1|2,        // elevation rise (slopes only)
  preventChaining?: true,      // WFC anti-clustering flag
}
TileType = { GRASS: 0, WATER: 1, ROAD_A: 2, ... }  // name→index lookup
```

### Per-Cell Data (after WFC solve)
```js
globalCells: Map<cubeKey, { type, rotation, level }>
// cubeKey = "q,r,s" string
// type = index into TILE_LIST
// rotation = 0–5 (×60°)
// level = 0–4 (elevation)
```

### Per-Grid Tile (HexGrid internal)
```js
tile = {
  id,                    // unique tile ID
  gridX, gridZ,          // offset coords within grid
  type,                  // TILE_LIST index
  rotation,              // 0–5
  level,                 // 0–4
}
```

### Zone Sets (from placers)
```js
forestCells: Set<cubeKey>   // from ForestPlacer
villageCells: Set<cubeKey>  // from VillagePlacer
// passed into Decorations as tile ID sets:
options.forestTileIds: Set<tile.id>
options.villageTileIds: Set<tile.id>
```

### Decoration Instances (Decorations.js)
```js
// Single merged BatchedMesh per grid, all decoration types share it
this.trees = [{ tile, meshName, instanceId, rotationY, ox, oz }]
this.buildings = [{ tile, meshName, instanceId, rotationY }]
this.bridges = [{ tile, meshName, instanceId }]
// etc. for waterlilies, flowers, rocks, hills, mountains
```

### Decoration Defs (DecorationDefs.js)
```js
// Weighted pick pools:
BuildingDefs = [{ name: 'building_home_A_yellow', weight: 15 }, ...]
HillDefs = [{ name: 'hills_A', weight: 5 }, ...]

// Mesh name lists (for geometry init):
TreeMeshNames, BuildingMeshNames, FlowerMeshNames, ...

// Instance caps:
MAX_TREES = 100, MAX_BUILDINGS = 40, ...
MAX_DEC_INSTANCES = sum of all caps  // BatchedMesh total
```

### Noise Fields (DecorationDefs.js)
```js
globalNoiseA  // ScaledNoise, freq 0.05 — tree channel A
globalNoiseB  // ScaledNoise, freq 0.05 — tree channel B
globalNoiseC  // ScaledNoise, freq 0.02 — village/building channel
// Each wraps SimplexNoise, .scaled2D(x,y) returns [0,1]
```

### Terrain Density (TerrainNoise.js)
```js
buildTerrainDensity(globalCells, riverCells) → {
  forestDensity: Map<cubeKey, number>,   // 0–1
  villageDensity: Map<cubeKey, number>,  // 0–1
}
```

### Cube Coordinates & Neighbors
```js
// 6 directions:
CUBE_DIRS = [
  { name:'NE', dq:+1, dr:-1, ds:0 },
  { name:'E',  dq:+1, dr:0,  ds:-1 },
  // ... SW, W, NW
]
cubeKey(q,r,s) → "q,r,s"
cubeDistance(a,b) → max(|Δq|,|Δr|,|Δs|)
```

---

## Architecture Approach

### Placement strategy: Tile replacement (not overlay)

Fields are **full tiles** — new tile types (FIELD_WHEAT, FIELD_PLOWED) that replace GRASS tiles post-WFC, similar to how rivers work. This gives proper edge-aware rendering and integrates cleanly with the tile system. After WFC solves, `FieldPlacer` identifies eligible grass cells and replaces their `type` in `globalCells` with the appropriate field tile type.

### Zone logic: Where do fields go?

Fields occupy **flat GRASS tiles (level 0–1)** that are:
- **Near villages** — within 2–3 hex of a `villageCells` member (farmland around settlements)
- **Not in forest zones** — fields are cleared land
- **Not on road beds** — already have `isOnRoadBed()` for exclusion
- **Adjacent to roads is a bonus** — farms along roads feel natural

A new `FieldPlacer.js` (following the `ForestPlacer.js` pattern) computes a `fieldCells: Set<cubeKey>`. Density formula:

```
villageFade  = max(0, 1 - distToVillage / fieldRange)
fieldDensity = noiseC * villageFade * coastFade * elevationShape
```

This naturally rings villages with farmland, fading into open grass further out.

### Rotation alignment

Fields should feel oriented, not random. Three strategies in priority order:

1. **Road-aligned** — if a neighbor has a road edge, orient field rows parallel to the road direction. Reuse the `dirToAngle` mapping from `populateBuildings()`.
2. **Noise-coherent** — use a noise field to assign rotation in 60° increments (`0–5 × π/3`), so adjacent fields share orientation. Creates the look of large contiguous farmland.
3. **Hybrid** — prefer road alignment when a road neighbor exists, fall back to noise-coherent rotation otherwise.

### Wheat vs. plowed selection

Within `populateFields()`, use noise at a higher frequency to decide per-cell:
```js
const fieldNoise = globalNoiseB.scaled2D(worldX * 2, worldZ * 2)
const meshName = fieldNoise > 0.5 ? 'field_wheat' : 'field_plowed'
```

This creates natural patches of each type rather than random salt-and-pepper.

### Interaction with other decorations

Fields **suppress trees** on the same tile (like buildings do). Since fields are full tile replacements, the tile type itself serves as the exclusion signal — no separate skip-set needed. Tree/flower placement already checks tile type.

---

## New Data Structures for Fields

```js
// FieldPlacer output:
fieldCells: Set<cubeKey>

// New tile types in TILE_LIST:
TileType.FIELD_WHEAT  // index into TILE_LIST
TileType.FIELD_PLOWED // index into TILE_LIST

// globalCells entries updated in-place:
globalCells.get(key).type = TileType.FIELD_WHEAT  // was GRASS
```

---

## Mesh Assets Needed

These must be created in Blender and added to `hex-terrain.glb` as full tile meshes (same dimensions as `hex_grass`):

| Mesh name | Description |
|-----------|-------------|
| `hex_field_wheat` | Hex tile with golden wheat rows |
| `hex_field_plowed` | Hex tile with brown plowed furrows |

All meshes should match the standard hex tile dimensions, centered at origin, with Y=0 at top surface.

---

## Code Changes

| File | Change |
|------|--------|
| `HexTileData.js` | Add `FIELD_WHEAT` and `FIELD_PLOWED` tile definitions with grass edges |
| `TerrainNoise.js` | Add field density computation (village proximity + noise) |
| `FieldPlacer.js` **(new)** | Threshold field density → `fieldCells` Set, replace GRASS tiles with field types in `globalCells` |
| `HexMap.js` | Call `FieldPlacer.place()` in `_placeZones()` |
| `GUI.js` | Optional: field threshold slider, field range slider |

---

## Implementation Order

1. **Create field meshes** in Blender, add to `hex-terrain.glb` (art task)
2. **`HexTileData.js`** — define FIELD_WHEAT and FIELD_PLOWED tile types with grass edges
3. **`FieldPlacer.js`** — zone computation (village proximity ring), tile replacement in `globalCells`
4. **Pipeline wiring** in `HexMap._placeZones()`
5. **Tuning** — thresholds, noise frequency, rotation coherence, field range
