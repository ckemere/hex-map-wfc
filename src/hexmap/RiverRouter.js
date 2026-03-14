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
 * Does NOT replace tiles yet — only computes paths for debug visualisation.
 */

import { cubeKey, CUBE_DIRS, cubeDistance, getEdgeLevel } from './HexWFCCore.js'
import { TILE_LIST } from './HexTileData.js'
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

    const sources = this._selectSources()
    console.warn(`[RIVERS] Sources selected: ${sources.length}`)

    // globalOwned: cells committed to finalized river paths.
    // Separate from riverCells so that per-river BFS trees don't interfere.
    const globalOwned = new Map()

    for (let i = 0; i < sources.length; i++) {
      this._routeRiver(sources[i], i, globalOwned)
    }

    console.warn(`[RIVERS] Routed ${this.rivers.length} rivers, ${this.riverCells.size} cells`)
    return { rivers: this.rivers, riverCells: this.riverCells }
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
   */
  _routeRiver(sourceKey, riverIndex, globalOwned) {
    const source = this.globalCells.get(sourceKey)
    if (!source) return

    // Per-river BFS state
    const cameFrom = new Map()   // key → parentKey (null for source)
    const costSoFar = new Map()  // key → best cost to reach this cell
    const frontier = new MinHeap()

    cameFrom.set(sourceKey, null)
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

      // Expand all 6 neighbors
      for (let d = 0; d < 6; d++) {
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
          goals.push({ goalKey: nk, goalType: GoalType.CONFLUENCE, traceTo: currentKey, cost: currentCost })
          continue
        }

        const def = TILE_LIST[neighbor.type]
        if (!def) continue

        const edgeVals = Object.values(def.edges)
        const isWater = edgeVals.every(e => e === 'water')
        const hasCoast = edgeVals.some(e => e === 'coast')

        // --- Coast/water: goal, don't expand further ---
        if (isWater || hasCoast) {
          goals.push({ goalKey: nk, goalType: GoalType.COAST, traceTo: currentKey, cost: currentCost })
          continue
        }

        // --- Elevation check: only expand to downhill or flat ---
        const exitEdgeLevel = edgeLevelAt(current, d)
        const oppositeDir = (d + 3) % 6
        const entryEdgeLevel = edgeLevelAt(neighbor, oppositeDir)
        const effectiveElev = Math.max(cellElevation(neighbor), entryEdgeLevel)

        // Only allow downhill or flat (relative to exit edge)
        if (effectiveElev > exitEdgeLevel) continue

        // --- Adjacency confluence check ---
        // If this candidate cell is adjacent to a cell owned by another river,
        // treat it as a confluence goal. This prevents two rivers from running
        // in parallel on neighboring cells (especially on flat terrain).
        if (this._isAdjacentToOwnedRiver(nq, nr, ns, globalOwned)) {
          goals.push({ goalKey: nk, goalType: GoalType.CONFLUENCE, traceTo: currentKey, cost: currentCost })
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
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

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
}
