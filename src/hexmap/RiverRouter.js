/**
 * RiverRouter — post-WFC river placement (Step 2 of the two-pass river system)
 *
 * After WFC completes, routes rivers downhill from high-elevation sources to
 * coast/water/map-edge using BFS tree expansion in cube coordinates.
 *
 * Algorithm:
 *   1. Select sources (highest elevation first)
 *   2. For each source, expand a BFS tree outward through downhill/flat neighbors
 *   3. When the tree reaches a goal (coast, edge, or existing river), trace
 *      the parent pointers back to the source to extract the path
 *   4. Commit the path into a shared globalOwned map so later rivers can
 *      detect confluences
 *
 * After routing, `computeReplacements()` selects the best river tile type
 * and rotation for each path cell, returning an array of tile descriptors
 * that can be applied via HexMap.applyTileResultsToGrids().
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance, getEdgeLevel } from './HexWFCCore.js'
import { TILE_LIST, TileType, HexDir, HexOpposite, rotateHexEdges } from './HexTileData.js'
import { random } from '../SeededRandom.js'

/**
 * Cell classification for debug visualisation
 */
export const RiverCellType = {
  SOURCE: 'source',
  PATH: 'path',
  CONFLUENCE: 'confluence',
  COAST_END: 'coast_end',
  EDGE_END: 'edge_end',
  BASIN_END: 'basin_end',
  SLOPE: 'slope',           // on a slope tile with levelIncrement 1 (has tile)
  SLOPE_MISSING: 'slope_missing', // on a slope tile with levelIncrement > 1 (no tile)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Effective elevation of a cell (base level, i.e. the low side of slopes). */
function cellElevation(cell) {
  return cell.level
}

/** Edge level on a given side of a cell, accounting for slope rotation. */
function edgeLevelAt(cell, dirIndex) {
  const dirName = CUBE_DIRS[dirIndex].name
  return getEdgeLevel(cell.type, cell.rotation, dirName, cell.level)
}

/** Simple hash-based noise in [0,1) for source weighting. */
function coordNoise(q, r, freq) {
  const x = q * freq
  const z = r * freq
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

// ---------------------------------------------------------------------------
// Min-heap priority queue (binary heap, smallest cost first)
// ---------------------------------------------------------------------------

class MinHeap {
  constructor() { this._data = [] }

  get size() { return this._data.length }

  push(item) {
    this._data.push(item)
    this._bubbleUp(this._data.length - 1)
  }

  pop() {
    const top = this._data[0]
    const last = this._data.pop()
    if (this._data.length > 0) {
      this._data[0] = last
      this._sinkDown(0)
    }
    return top
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this._data[i].cost < this._data[parent].cost) {
        [this._data[i], this._data[parent]] = [this._data[parent], this._data[i]]
        i = parent
      } else break
    }
  }

  _sinkDown(i) {
    const n = this._data.length
    while (true) {
      let smallest = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this._data[l].cost < this._data[smallest].cost) smallest = l
      if (r < n && this._data[r].cost < this._data[smallest].cost) smallest = r
      if (smallest === i) break
      ;[this._data[i], this._data[smallest]] = [this._data[smallest], this._data[i]]
      i = smallest
    }
  }
}

// ---------------------------------------------------------------------------
// Goal types returned by the BFS expansion
// ---------------------------------------------------------------------------

const GoalType = {
  COAST: 'coast',
  EDGE: 'edge',
  CONFLUENCE: 'confluence',
}

// Goal preference: lower = better
const GOAL_PRIORITY = { [GoalType.COAST]: 0, [GoalType.CONFLUENCE]: 1, [GoalType.EDGE]: 2 }

// ---------------------------------------------------------------------------
// Direction-set → tile lookup table (6-bit bitmask, 64 entries)
// ---------------------------------------------------------------------------

/** Convert a Set or iterable of direction indices (0–5) to a 6-bit mask. */
function dirSetToMask(dirs) {
  let mask = 0
  for (const d of dirs) mask |= (1 << d)
  return mask
}

/** All river tile templates: unrotated direction indices for each tile type. */
const ALL_RIVER_TILES = [
  { type: TileType.RIVER_END,    dirs: [4] },        // 1-edge: W
  { type: TileType.RIVER_A,      dirs: [1, 4] },     // 2-edge straight: E, W
  { type: TileType.RIVER_B,      dirs: [0, 4] },     // 2-edge curve: NE, W
  { type: TileType.RIVER_D,      dirs: [0, 2, 4] },  // 3-edge: NE, SE, W
  { type: TileType.RIVER_E,      dirs: [0, 1, 4] },  // 3-edge: NE, E, W
  { type: TileType.RIVER_F,      dirs: [1, 2, 4] },  // 3-edge: E, SE, W
]

/**
 * Pre-computed lookup: bitmask → { type, rotation }.
 * For every tile template at every rotation, compute the resulting bitmask
 * and store the first match. Covers all 64 possible direction combinations.
 */
const RIVER_TILE_LOOKUP = new Array(64).fill(null)
for (const { type, dirs } of ALL_RIVER_TILES) {
  for (let r = 0; r < 6; r++) {
    const mask = dirs.reduce((m, d) => m | (1 << ((d + r) % 6)), 0)
    if (!RIVER_TILE_LOOKUP[mask]) {
      RIVER_TILE_LOOKUP[mask] = { type, rotation: r }
    }
  }
}

// ---------------------------------------------------------------------------
// RiverRouter
// ---------------------------------------------------------------------------

export class RiverRouter {
  /**
   * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
   * @param {Object} [options]
   * @param {number} [options.minSourceLevel=2]       — minimum cell level for source placement
   * @param {number} [options.minSourceDistance=6]     — minimum hex distance between sources
   * @param {number} [options.noiseFreq=0.08]          — frequency of source probability noise
   * @param {number} [options.maxExpansion=600]        — max cells expanded per river BFS
   * @param {number} [options.distanceCost=0.15]       — per-step cost to prefer shorter paths
   * @param {number} [options.edgePenalty=2.0]         — cost penalty per missing neighbor (edge proximity)
   */
  constructor(globalCells, options = {}) {
    this.globalCells = globalCells
    this.minSourceLevel = options.minSourceLevel ?? 2
    this.minSourceDistance = options.minSourceDistance ?? 6
    this.noiseFreq = options.noiseFreq ?? 0.08
    this.maxExpansion = options.maxExpansion ?? 600
    this.distanceCost = options.distanceCost ?? 0.15
    this.edgePenalty = options.edgePenalty ?? 2.0

    /** @type {Map<string, { type: string, riverIndex: number }>} cubeKey → river cell info */
    this.riverCells = new Map()

    /** @type {Array<{ source: string, path: string[], endType: string }>} */
    this.rivers = []
  }

  /**
   * Run the full routing pass. Clears previous results.
   * @returns {{ rivers: Array, riverCells: Map }}
   */
  route() {
    this.riverCells.clear()
    this.rivers.length = 0

    const firstEntry = this.globalCells.entries().next().value
    if (firstEntry) {
      const [k, v] = firstEntry
      console.warn('[RIVERS] Sample cell:', k, JSON.stringify(v))
    }

    // Pre-compute all valid river mouth positions before routing.
    // For each cell where RIVER_INTO_COAST fits, record the set of valid
    // river entry directions. The BFS then just does a map lookup.
    this.validMouths = this._findValidRiverMouths()
    console.warn(`[RIVERS] Valid river mouth positions: ${this.validMouths.size}`)

    const sources = this._selectSources()
    console.warn(`[RIVERS] Sources selected: ${sources.length}`)

    // globalOwned: cells committed to finalized river paths.
    // Separate from riverCells so that per-river BFS trees don't interfere.
    const globalOwned = new Map()

    // globalDirs: track river edge directions per cell as bitmasks so we
    // can validate confluences via the lookup table.
    const globalDirs = new Map() // cubeKey → 6-bit direction bitmask

    for (let i = 0; i < sources.length; i++) {
      this._routeRiver(sources[i], i, globalOwned, globalDirs)
    }

    // Post-pass: tag river cells on slope tiles for debug overlay
    this._tagSlopeCells()

    console.warn(`[RIVERS] Routed ${this.rivers.length} rivers, ${this.riverCells.size} cells`)
    return { rivers: this.rivers, riverCells: this.riverCells }
  }

  /**
   * Tag river cells where the river drops in elevation.
   *
   * Walks each river path in order (source → goal) and compares the
   * effective elevation of consecutive cells.  A cell is tagged SLOPE
   * when its level is strictly higher than the next cell's level.
   *
   * For flat tiles the effective elevation is simply `cell.level`.
   * For slope tiles we use `cell.level + 0.5 * levelIncrement` so that
   * a slope tile sorts between its low and high neighbours.
   */
  _tagSlopeCells() {
    const effectiveLevel = (cell) => {
      const def = TILE_LIST[cell.type]
      if (def?.highEdges?.length) {
        return cell.level + 0.5 * (def.levelIncrement ?? 1)
      }
      return cell.level
    }

    for (const river of this.rivers) {
      const { path } = river
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i]
        const info = this.riverCells.get(key)
        if (!info) continue
        // Only re-tag PATH cells (don't overwrite source/confluence/etc.)
        if (info.type !== RiverCellType.PATH) continue

        const cell = this.globalCells.get(key)
        const nextCell = this.globalCells.get(path[i + 1])
        if (!cell || !nextCell) continue

        if (effectiveLevel(cell) > effectiveLevel(nextCell)) {
          info.type = RiverCellType.SLOPE
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Source selection (unchanged from greedy version)
  // ---------------------------------------------------------------------------

  _selectSources() {
    const candidates = []
    const levelCounts = new Map()
    for (const [key, cell] of this.globalCells) {
      const level = cellElevation(cell)
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1)

      if (level < this.minSourceLevel) continue

      const def = TILE_LIST[cell.type]
      if (!def) continue
      const edgeVals = Object.values(def.edges)
      if (edgeVals.every(e => e === 'water')) continue
      if (edgeVals.some(e => e === 'coast')) continue
      if (edgeVals.some(e => e === 'river')) continue
      if (this._countEdgeNeighbors(cell.q, cell.r, cell.s) > 0) continue

      const noise = coordNoise(cell.q, cell.r, this.noiseFreq)
      const weight = level * noise
      candidates.push({ key, cell, weight })
    }

    const dist = [...levelCounts.entries()].sort((a, b) => a[0] - b[0])
      .map(([l, c]) => `L${l}:${c}`).join(' ')
    console.warn(`[RIVERS] Elevation distribution: ${dist}, candidates (level≥${this.minSourceLevel}): ${candidates.length}`)

    candidates.sort((a, b) => b.weight - a.weight)

    const sources = []
    const sourceCoords = []

    for (const { key, cell } of candidates) {
      let tooClose = false
      for (const sc of sourceCoords) {
        if (cubeDistance(cell.q, cell.r, cell.s, sc.q, sc.r, sc.s) < this.minSourceDistance) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      sources.push(key)
      sourceCoords.push({ q: cell.q, r: cell.r, s: cell.s })
    }

    return sources
  }

  // ---------------------------------------------------------------------------
  // BFS tree expansion
  // ---------------------------------------------------------------------------

  /**
   * Route a single river by expanding a BFS tree from the source.
   * The tree grows through downhill and flat neighbors. When a goal is
   * reached (coast, map edge, or existing river), trace the parent pointers
   * back to the source to extract the river path.
   *
   * @param {string} sourceKey
   * @param {number} riverIndex
   * @param {Map} globalOwned — cells committed by previously routed rivers
   * @param {Map} globalDirs — river edge directions per cell (for confluence validation)
   */
  _routeRiver(sourceKey, riverIndex, globalOwned, globalDirs) {
    const source = this.globalCells.get(sourceKey)
    if (!source) return

    // Per-river BFS state
    const cameFrom = new Map()   // key → parentKey (null for source)
    const entryDir = new Map()   // key → direction index the river enters from (null for source)
    const costSoFar = new Map()  // key → best cost to reach this cell
    const frontier = new MinHeap()

    cameFrom.set(sourceKey, null)
    entryDir.set(sourceKey, null)
    costSoFar.set(sourceKey, 0)
    frontier.push({ key: sourceKey, cost: 0 })

    // Collect all goals reached during expansion
    // { goalKey, goalType, traceTo } where traceTo is the last cell in our
    // tree (for edge/confluence, the cell before the goal)
    const goals = []

    let expanded = 0

    while (frontier.size > 0 && expanded < this.maxExpansion) {
      const { key: currentKey, cost: currentCost } = frontier.pop()

      // Skip if we already found a better path to this cell
      if (currentCost > costSoFar.get(currentKey)) continue

      expanded++

      const current = this.globalCells.get(currentKey)
      if (!current) continue

      const currentElev = cellElevation(current)

      // Determine valid exit directions based on river tile geometry.
      // From a cell entered in direction e, the river can exit to:
      //   (e+2)%6  — 120° bend (RIVER_B)
      //   (e+3)%6  — 180° straight (RIVER_A)
      //   (e+4)%6  — 120° bend (RIVER_B)
      // 60° sharp turns (e+1, e+5) have no valid 2-edge river tile.
      // Source cells (no entry direction) can exit in any direction.
      const e = entryDir.get(currentKey)
      const validExits = e === null
        ? [0, 1, 2, 3, 4, 5]
        : [(e + 2) % 6, (e + 3) % 6, (e + 4) % 6]

      // Compute the elevation at which the river entered this cell.
      // Exit edges must not be higher than this, or the river would go
      // uphill through the tile (e.g. entering a cliff from the low side
      // and exiting from the high side).
      const currentEntryEdgeLevel = e === null
        ? cellElevation(current)   // source: use base level
        : edgeLevelAt(current, e)

      for (const d of validExits) {
        // Prevent uphill traversal through slope/cliff tiles: the exit
        // edge must not be higher than the entry edge of this cell.
        const exitEdgeLevel_current = edgeLevelAt(current, d)
        if (exitEdgeLevel_current > currentEntryEdgeLevel) continue

        const dir = CUBE_DIRS[d]
        const nq = current.q + dir.dq
        const nr = current.r + dir.dr
        const ns = current.s + dir.ds
        const nk = cubeKey(nq, nr, ns)
        const neighbor = this.globalCells.get(nk)

        // --- Map edge: goal, don't expand further ---
        if (!neighbor) {
          goals.push({ goalKey: nk, goalType: GoalType.EDGE, traceTo: currentKey, cost: currentCost })
          continue
        }

        // --- Already in our own tree: skip (prevents loops) ---
        if (cameFrom.has(nk)) continue

        // --- Owned by a previous river: confluence goal ---
        if (globalOwned.has(nk)) {
          // Check that adding our direction won't create an invalid 3-edge
          // pattern (3 consecutive directions have no valid tile)
          const newDir = (d + 3) % 6 // direction we'd enter the confluence cell from
          if (this._isValidConfluence(nk, newDir, globalDirs)) {
            goals.push({ goalKey: nk, goalType: GoalType.CONFLUENCE, traceTo: currentKey, cost: currentCost })
          }
          continue
        }

        const def = TILE_LIST[neighbor.type]
        if (!def) continue

        const edgeVals = Object.values(def.edges)
        const isWater = edgeVals.every(e => e === 'water')
        const hasCoast = edgeVals.some(e => e === 'coast')

        // --- Elevation check (applied to ALL neighbors including coast/water) ---
        const exitEdgeLevel = exitEdgeLevel_current
        const oppositeDir = (d + 3) % 6
        const entryEdgeLevel = edgeLevelAt(neighbor, oppositeDir)

        // Rivers can flow downhill across cliffs (exit > entry) or flat
        // (exit == entry), but NEVER uphill (entry > exit).
        if (entryEdgeLevel > exitEdgeLevel) continue

        const effectiveElev = Math.max(cellElevation(neighbor), entryEdgeLevel)

        // Also block if the neighbor's overall elevation is higher than
        // our exit edge (prevents flowing uphill into high plateaus).
        if (effectiveElev > exitEdgeLevel) continue

        // --- Coast/water: goal if this is a pre-computed valid mouth ---
        if (isWater || hasCoast) {
          const validDirs = this.validMouths.get(nk)
          const riverEntryDir = (d + 3) % 6
          if (validDirs && validDirs.has(riverEntryDir)) {
            goals.push({ goalKey: nk, goalType: GoalType.COAST, traceTo: currentKey, cost: currentCost })
          }
          continue
        }

        // --- Adjacency confluence check ---
        // If this candidate cell is adjacent to a cell owned by another river,
        // extend the path through nk to the actual owned cell so the
        // confluence tile (3-way junction) lands on the existing river.
        if (this._isAdjacentToOwnedRiver(nq, nr, ns, globalOwned)) {
          const ownedKey = this._findAdjacentOwnedRiver(nq, nr, ns, globalOwned)
          // Compute direction from nk into the owned cell
          const ownedCoord = parseCubeKey(ownedKey)
          const dirToOwned = this._directionBetween(
            { q: nq, r: nr, s: ns }, ownedCoord
          )
          if (dirToOwned < 0) continue
          const entryIntoOwned = (dirToOwned + 3) % 6
          if (!this._isValidConfluence(ownedKey, entryIntoOwned, globalDirs)) continue
          // Add nk to BFS tree so it can be traced through
          cameFrom.set(nk, currentKey)
          entryDir.set(nk, (d + 3) % 6)
          goals.push({ goalKey: ownedKey, goalType: GoalType.CONFLUENCE, traceTo: nk, cost: currentCost })
          continue
        }

        // --- Compute cost to reach this neighbor ---
        let stepCost = effectiveElev + this.distanceCost

        // Penalize edge-adjacent cells
        const edgeCount = this._countEdgeNeighbors(nq, nr, ns)
        if (edgeCount > 0) {
          stepCost += this.edgePenalty * edgeCount
        }

        const newCost = currentCost + stepCost

        // Only expand if this is a better path
        if (!costSoFar.has(nk) || newCost < costSoFar.get(nk)) {
          costSoFar.set(nk, newCost)
          cameFrom.set(nk, currentKey)
          entryDir.set(nk, (d + 3) % 6) // direction river enters neighbor from
          frontier.push({ key: nk, cost: newCost })
        }
      }
    }

    // --- Pick the best goal ---
    if (goals.length === 0) {
      // No goal reached — basin end at source
      this.riverCells.set(sourceKey, { type: RiverCellType.BASIN_END, riverIndex })
      this.rivers.push({ source: sourceKey, path: [sourceKey], endType: RiverCellType.BASIN_END })
      globalOwned.set(sourceKey, { riverIndex })
      return
    }

    // Sort goals: prefer coast > confluence > edge, then by cost
    goals.sort((a, b) => {
      const pa = GOAL_PRIORITY[a.goalType], pb = GOAL_PRIORITY[b.goalType]
      if (pa !== pb) return pa - pb
      return a.cost - b.cost
    })

    const bestGoal = goals[0]

    // --- Trace path from goal back to source ---
    const path = []
    let traceKey = bestGoal.traceTo
    while (traceKey !== null) {
      path.push(traceKey)
      traceKey = cameFrom.get(traceKey)
    }
    path.reverse() // now source → ... → cell-before-goal

    // Determine end type and mark cells
    let endType
    switch (bestGoal.goalType) {
      case GoalType.COAST:
        endType = RiverCellType.COAST_END
        break
      case GoalType.EDGE:
        endType = RiverCellType.EDGE_END
        break
      case GoalType.CONFLUENCE:
        endType = RiverCellType.CONFLUENCE
        break
    }

    // Mark source
    this.riverCells.set(path[0], { type: RiverCellType.SOURCE, riverIndex })
    globalOwned.set(path[0], { riverIndex })

    // Mark intermediate path cells
    for (let i = 1; i < path.length; i++) {
      this.riverCells.set(path[i], { type: RiverCellType.PATH, riverIndex })
      globalOwned.set(path[i], { riverIndex })
    }

    // Mark the goal cell itself
    const goalKey = bestGoal.goalKey
    if (endType === RiverCellType.COAST_END) {
      path.push(goalKey)
      this.riverCells.set(goalKey, { type: RiverCellType.COAST_END, riverIndex })
      globalOwned.set(goalKey, { riverIndex })
    } else if (endType === RiverCellType.CONFLUENCE) {
      path.push(goalKey)
      // Mark the confluence cell. If it's directly owned by a previous river,
      // keep that river's ownership. Otherwise (adjacency-based merge) claim
      // it for the current river.
      const owned = globalOwned.get(goalKey)
      const ownerIndex = owned ? owned.riverIndex : riverIndex
      this.riverCells.set(goalKey, { type: RiverCellType.CONFLUENCE, riverIndex: ownerIndex })
      if (!owned) globalOwned.set(goalKey, { riverIndex })
    } else if (endType === RiverCellType.EDGE_END) {
      // Edge cell is off-map, just mark the last real cell
      path.push(goalKey)
    }

    this.rivers.push({ source: sourceKey, path, endType })

    // Update globalDirs bitmasks with directions for all cells in this path
    for (let i = 0; i < path.length; i++) {
      const key = path[i]
      const cell = this.globalCells.get(key)
      if (!cell) continue
      let mask = globalDirs.get(key) ?? 0
      if (i > 0) {
        const prevCell = this.globalCells.get(path[i - 1])
        if (prevCell) {
          const d = this._directionBetween(cell, prevCell)
          if (d >= 0) mask |= (1 << d)
        }
      }
      if (i < path.length - 1) {
        const nextCell = this.globalCells.get(path[i + 1])
        if (nextCell) {
          const d = this._directionBetween(cell, nextCell)
          if (d >= 0) mask |= (1 << d)
        }
      }
      globalDirs.set(key, mask)
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Check whether adding a new river direction to an existing cell would
   * produce a direction set that has a valid river tile.
   *
   * @param {string} cellKey — the confluence cell
   * @param {number} newDir — the new direction being added
   * @param {Map<string, number>} globalDirs — existing direction bitmask per cell
   * @returns {boolean}
   */
  _isValidConfluence(cellKey, newDir, globalDirs) {
    const existing = globalDirs.get(cellKey) ?? 0
    const combined = existing | (1 << newDir)
    if (combined === existing) return true // direction already present
    return RIVER_TILE_LOOKUP[combined] !== null
  }

  /**
   * Check whether any of a cell's 6 neighbors belongs to a previously
   * committed river (in globalOwned). Used to force merges before two
   * rivers run side-by-side.
   */
  _isAdjacentToOwnedRiver(q, r, s, globalOwned) {
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      const nk = cubeKey(q + dir.dq, r + dir.dr, s + dir.ds)
      if (globalOwned.has(nk)) return true
    }
    return false
  }

  /**
   * Find the cubeKey of an adjacent cell that belongs to a previously
   * committed river. Returns the first match.
   */
  _findAdjacentOwnedRiver(q, r, s, globalOwned) {
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      const nk = cubeKey(q + dir.dq, r + dir.dr, s + dir.ds)
      if (globalOwned.has(nk)) return nk
    }
    return null
  }

  /**
   * Count how many of a cell's 6 neighbors are off the map edge.
   */
  _countEdgeNeighbors(q, r, s) {
    let count = 0
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      const nk = cubeKey(q + dir.dq, r + dir.dr, s + dir.ds)
      if (!this.globalCells.has(nk)) count++
    }
    return count
  }

  // ---------------------------------------------------------------------------
  // Tile replacement
  // ---------------------------------------------------------------------------

  /**
   * Compute tile replacements for all routed rivers.
   * Must be called after route().
   *
   * @returns {{ replacements: Array<{ q, r, s, type, rotation, level }> }}
   */
  computeReplacements() {
    // 1. Collect all river direction indices per cell across all rivers.
    //    A cell may appear in multiple paths (confluence), so we accumulate
    //    a Set of direction indices where a river edge is needed.
    const cellDirs = new Map()  // cubeKey → Set<dirIndex>
    const cellEndType = new Map() // cubeKey → endType (for terminal cells)

    for (const river of this.rivers) {
      const { path, endType } = river

      for (let i = 0; i < path.length; i++) {
        const key = path[i]
        const cell = this.globalCells.get(key)
        if (!cell) continue  // off-map (edge end goal)

        if (!cellDirs.has(key)) cellDirs.set(key, new Set())
        const dirs = cellDirs.get(key)

        // Direction toward previous cell in path (entry)
        if (i > 0) {
          const prevCell = this.globalCells.get(path[i - 1])
          if (prevCell) {
            const d = this._directionBetween(cell, prevCell)
            if (d >= 0) dirs.add(d)
          }
        }

        // Direction toward next cell in path (exit)
        if (i < path.length - 1) {
          const nextCell = this.globalCells.get(path[i + 1])
          if (nextCell) {
            const d = this._directionBetween(cell, nextCell)
            if (d >= 0) dirs.add(d)
          }
        }

        // Track end type for terminal cells
        if (i === path.length - 1) {
          cellEndType.set(key, endType)
        }
      }
    }

    // 2. For each cell, select the best river tile + rotation.
    const replacements = []
    let replaced = 0, skipped = 0

    for (const [key, dirs] of cellDirs) {
      const cell = this.globalCells.get(key)
      if (!cell) continue

      const endType = cellEndType.get(key)

      // Coast-end cells: place RIVER_INTO_COAST directly.
      // BFS already validated the 5 non-river edges via the pre-computed
      // validMouths map, so we just compute the rotation and place it.
      if (endType === RiverCellType.COAST_END) {
        if (dirs.size !== 1) {
          console.warn(`[RIVERS] Coast cell at (${cell.q},${cell.r},${cell.s}) has ${dirs.size} river dirs, expected 1`)
          skipped++
          continue
        }
        const riverDir = dirs.values().next().value
        const rotation = (riverDir - 5 + 6) % 6
        replacements.push({
          q: cell.q, r: cell.r, s: cell.s,
          type: TileType.RIVER_INTO_COAST,
          rotation,
          level: cell.level,
        })
        replaced++
        continue
      }

      const match = selectRiverTile(dirs)
      if (!match) {
        skipped++
        continue
      }

      // If the original tile was a slope (levelIncrement: 1) and the river
      // is straight, use the slope river variant instead of flat.
      let finalType = match.type
      let finalRotation = match.rotation
      const originalDef = TILE_LIST[cell.type]
      const isSlope = originalDef?.highEdges?.length > 0
      if (isSlope && originalDef.levelIncrement === 1) {
        if (finalType === TileType.RIVER_A || finalType === TileType.RIVER_A_CURVY) {
          // Slope axis is E(1)-W(4) rotated by cell.rotation.
          // River must align with this axis for the slope tile to work.
          const slopeAxisA = (1 + cell.rotation) % 6
          const slopeAxisB = (4 + cell.rotation) % 6
          const riverDirA = (1 + finalRotation) % 6
          const riverDirB = (4 + finalRotation) % 6
          if ((riverDirA === slopeAxisA && riverDirB === slopeAxisB) ||
              (riverDirA === slopeAxisB && riverDirB === slopeAxisA)) {
            finalType = TileType.RIVER_A_SLOPE_LOW
            finalRotation = cell.rotation
          } else {
            console.warn(`[RIVERS] Slope at (${cell.q},${cell.r},${cell.s}) river axis [${riverDirA},${riverDirB}] doesn't match slope axis [${slopeAxisA},${slopeAxisB}], cell.rotation=${cell.rotation}, original=${originalDef.name}`)
          }
        }
      } else if (isSlope) {
        console.warn(`[RIVERS] Slope at (${cell.q},${cell.r},${cell.s}) has levelIncrement=${originalDef.levelIncrement}, no river slope tile available, original=${originalDef.name}`)
      }

      replacements.push({
        q: cell.q, r: cell.r, s: cell.s,
        type: finalType,
        rotation: finalRotation,
        level: cell.level,
      })
      replaced++
    }

    console.warn(`[RIVERS] Tile replacements: ${replaced} replaced, ${skipped} skipped`)
    return { replacements }
  }

  /**
   * Find the direction index (0–5) from cell A to cell B.
   * Returns -1 if they are not adjacent.
   */
  _directionBetween(cellA, cellB) {
    const dq = cellB.q - cellA.q
    const dr = cellB.r - cellA.r
    const ds = cellB.s - cellA.s
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      if (dir.dq === dq && dir.dr === dr && dir.ds === ds) return d
    }
    return -1
  }

  /**
   * Scan all cells and find every position where RIVER_INTO_COAST could fit.
   * Returns Map<cubeKey, Set<entryDir>> — each key maps to the set of
   * river-entry directions (0–5) that produce a valid placement.
   *
   * Only checks the 5 non-river edges; the river-side neighbor will become
   * a river tile at placement time so its current tile doesn't matter.
   */
  _findValidRiverMouths() {
    const mouths = new Map() // cubeKey → Set<entryDir>

    for (const [key, cell] of this.globalCells) {
      const def = TILE_LIST[cell.type]
      if (!def) continue

      const edgeVals = Object.values(def.edges)
      // Only consider coast/water cells (same filter as BFS goal detection)
      const isWater = edgeVals.every(e => e === 'water')
      const hasCoast = edgeVals.some(e => e === 'coast')
      if (!isWater && !hasCoast) continue

      const validDirs = new Set()
      for (let entryDir = 0; entryDir < 6; entryDir++) {
        if (this._isValidRiverMouth(cell, entryDir)) {
          validDirs.add(entryDir)
        }
      }

      if (validDirs.size > 0) {
        mouths.set(key, validDirs)
      }
    }

    return mouths
  }

  /**
   * Check whether RIVER_INTO_COAST can fit at a coast cell with the river
   * entering from `riverEntryDir` (0–5).  Used by _findValidRiverMouths
   * to pre-compute valid mouth positions.
   *
   * Skips the river-edge neighbor (that cell will become a river tile later)
   * and validates the remaining 5 edges against the actual surrounding tiles.
   */
  _isValidRiverMouth(cell, riverEntryDir) {
    // RIVER_INTO_COAST has river edge at NW (index 5) unrotated.
    const rotation = (riverEntryDir - 5 + 6) % 6
    const rotatedEdges = rotateHexEdges(TILE_LIST[TileType.RIVER_INTO_COAST].edges, rotation)

    for (let d = 0; d < 6; d++) {
      // Skip the river-entry edge — that neighbor will become a river tile
      if (d === riverEntryDir) continue

      const dirName = HexDir[d]
      const requiredEdge = rotatedEdges[dirName]
      const oppDirName = HexOpposite[dirName]

      const dir = CUBE_DIRS[d]
      const nk = cubeKey(cell.q + dir.dq, cell.r + dir.dr, cell.s + dir.ds)
      const neighbor = this.globalCells.get(nk)

      if (!neighbor) {
        // Off-map — only compatible with water edges
        if (requiredEdge !== 'water') return false
        continue
      }

      const neighborEdges = rotateHexEdges(TILE_LIST[neighbor.type].edges, neighbor.rotation)
      const neighborEdge = neighborEdges[oppDirName]

      if (requiredEdge !== neighborEdge) return false
    }

    return true
  }

}

// ---------------------------------------------------------------------------
// River tile selection — lookup-based mapping from direction sets to tile+rotation
// ---------------------------------------------------------------------------

/**
 * Given a set of required river direction indices, find the best tile type
 * and rotation via the pre-computed lookup table.
 *
 * @param {Set<number>} requiredDirs — direction indices (0–5) needing river edges
 * @returns {{ type: number, rotation: number } | null}
 */
function selectRiverTile(requiredDirs) {
  const mask = dirSetToMask(requiredDirs)
  if (mask === 0) return null

  const match = RIVER_TILE_LOOKUP[mask]
  if (!match) {
    console.warn(`[RIVERS] No valid tile for direction mask 0b${mask.toString(2).padStart(6, '0')}`)
    return null
  }

  // Randomize straight river variant (A vs A_CURVY share the same edge geometry)
  if (match.type === TileType.RIVER_A && random() < 0.5) {
    return { type: TileType.RIVER_A_CURVY, rotation: match.rotation }
  }

  return { type: match.type, rotation: match.rotation }
}
