# Simplify River Routing & Tile Placement

## Core Observation

The main complexity comes from **two places doing the same work with different approaches**:

1. **Confluence validation** (`_isValidConfluence`) needs to know "can these N directions be tiled?" — it does this by iterating `RIVER_TILES_3` templates and calling `matchTile3()`.
2. **Tile selection** (`selectRiverTile`) needs to answer the same question AND return the tile+rotation — it uses separate logic per edge count (1, 2, 3, 4+), with manual rotation math for each case.

Both are computing: **"given a set of hex direction indices, what tile+rotation covers exactly those river edges?"** — just one wants a boolean and the other wants the tile.

## Proposed Simplification: Pre-computed Direction-Set → Tile Lookup Table

### The idea

Represent each possible set of river directions as a **6-bit number** (bit 0 = NE, bit 1 = E, ... bit 5 = NW). There are only 64 possible values. Pre-compute a lookup table mapping each bitmask to `{ type, rotation }` (or `null` if no tile exists).

```js
// Build once at module load
const RIVER_TILE_LOOKUP = new Array(64).fill(null)

// For each river tile template, for each rotation 0-5,
// compute the bitmask and store the result
for (const { type, dirs } of ALL_RIVER_TILES) {
  for (let r = 0; r < 6; r++) {
    const mask = dirs.reduce((m, d) => m | (1 << ((d + r) % 6)), 0)
    if (!RIVER_TILE_LOOKUP[mask]) {
      RIVER_TILE_LOOKUP[mask] = { type, rotation: r }
    }
  }
}
```

### What this replaces

| Current code | Replaced by |
|---|---|
| `matchTile3(required, template)` loop | `RIVER_TILE_LOOKUP[mask] !== null` |
| `selectRiverTile()` — all 80 lines of case-by-case logic | `RIVER_TILE_LOOKUP[mask]` |
| `_isValidConfluence()` — builds combined set, iterates templates | `RIVER_TILE_LOOKUP[combinedMask] !== null` |
| `RIVER_TILES_2` and `RIVER_TILES_3` separate template arrays | One unified `ALL_RIVER_TILES` array |

### Concrete changes

#### 1. Add `dirSetToMask()` helper + build `RIVER_TILE_LOOKUP` table (~20 lines)

Replaces `matchTile3`, `RIVER_TILES_2`, the separate `RIVER_TILES_3` usage in `selectRiverTile`, and the manual rotation arithmetic for each edge count.

#### 2. Rewrite `selectRiverTile(dirs)` → one-liner lookup

```js
function selectRiverTile(requiredDirs) {
  const mask = dirSetToMask(requiredDirs)
  return RIVER_TILE_LOOKUP[mask] ?? null
}
```

For the straight A vs A_CURVY randomization, the lookup stores one, and we add a small post-step:
```js
  const match = RIVER_TILE_LOOKUP[mask]
  if (!match) return null
  // Randomize straight variant
  if (match.type === TileType.RIVER_A && random() < 0.5) {
    return { type: TileType.RIVER_A_CURVY, rotation: match.rotation }
  }
  return { ...match }
```

#### 3. Simplify `_isValidConfluence()` — use bitmask directly

```js
_isValidConfluence(cellKey, newDir, globalDirs) {
  const existing = globalDirs.get(cellKey)
  const mask = existing ? dirSetToMask(existing) : 0
  const combined = mask | (1 << newDir)
  if (combined === mask) return true  // direction already present
  return RIVER_TILE_LOOKUP[combined] !== null
}
```

This replaces the current 24-line method with 5 lines and is more correct — it handles all edge counts uniformly instead of special-casing 2, 3, 4+.

#### 4. Switch `globalDirs` from `Map<string, Set<number>>` to `Map<string, number>` (bitmasks)

Since we're using bitmasks for lookup, store them as bitmasks too. This simplifies all the `globalDirs` manipulation code — `dirs.add(d)` becomes `dirs |= (1 << d)`, and set creation/merging becomes bitwise OR.

#### 5. Delete dead code

- Remove `matchTile3()` function
- Remove `RIVER_TILES_2` constant (folded into unified template list)
- Remove the separate `RIVER_TILES_3` usage in `selectRiverTile` (still needed for the lookup build, but referenced in one place only)

### What stays the same

- **BFS routing algorithm** (`_routeRiver`) — the pathfinding logic is well-structured and not overly complex
- **Source selection** (`_selectSources`) — straightforward greedy algorithm
- **River mouth validation** (`_findValidRiverMouths`, `_isValidRiverMouth`) — necessarily complex due to edge matching
- **Slope tile substitution** in `computeReplacements` — domain-specific, can't simplify further
- **MinHeap** — standard utility
- **Debug overlay** — separate concern

### Impact summary

- ~100 lines of tile-matching logic replaced by ~25 lines of lookup table construction + usage
- Confluence validation becomes trivially correct for all edge counts
- `globalDirs` becomes simpler (bitmask integers vs Sets)
- Single source of truth: the lookup table is the canonical "can this direction set be tiled?" answer
- No behavioral changes — purely a refactor
