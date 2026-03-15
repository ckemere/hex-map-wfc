/**
 * RoadRouter — post-WFC road placement
 *
 * Connects village clusters via Dijkstra expansion, Kruskal MST, and
 * degree-2 augmentation. Produces a road overlay (roadCells) for debug
 * visualisation and later tile replacement.
 *
 * Algorithm:
 *   1. Select terminals (prefer village-dense areas, optionally coastal anchors)
 *   2. Dijkstra expansion from each terminal to all reachable terminals
 *   3. Kruskal MST to connect all terminals
 *   4. Degree-2 augmentation (leafs get one extra connection)
 *   5. Path commitment with junction detection
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance, getEdgeLevel } from './HexWFCCore.js'
import { TILE_LIST, TileType, HexDir, HexOpposite, rotateHexEdges } from './HexTileData.js'
import { random } from '../SeededRandom.js'

/**
 * Cell classification for debug visualisation
 */
export const RoadCellType = {
  TERMINAL: 'terminal',
  PATH: 'path',
  JUNCTION: 'junction',
  ROAD_END: 'road_end',
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
// Union-Find for Kruskal's MST
// ---------------------------------------------------------------------------

class UnionFind {
  constructor() {
    this.parent = new Map()
    this.rank = new Map()
  }

  makeSet(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      this.rank.set(x, 0)
    }
  }

  find(x) {
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    // Path compression
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur)
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a, b) {
    const ra = this.find(a), rb = this.find(b)
    if (ra === rb) return false
    const rankA = this.rank.get(ra), rankB = this.rank.get(rb)
    if (rankA < rankB) this.parent.set(ra, rb)
    else if (rankA > rankB) this.parent.set(rb, ra)
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1) }
    return true
  }

  connected(a, b) { return this.find(a) === this.find(b) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Effective elevation of a cell (base level). */
function cellElevation(cell) {
  return cell.level
}

/** Edge level on a given side of a cell, accounting for slope rotation. */
function edgeLevelAt(cell, dirIndex) {
  const dirName = CUBE_DIRS[dirIndex].name
  return getEdgeLevel(cell.type, cell.rotation, dirName, cell.level)
}

/**
 * Check if a road can traverse a slope tile in the given direction.
 * Slope tiles only allow roads straight across the slope axis (E-W unrotated).
 * The road entry direction (oppositeDir) must match one of the two road-axis
 * directions after accounting for the slope's rotation.
 *
 * @param {Object} cell — the slope cell
 * @param {number} entryDirIndex — direction the road enters the cell from (0–5)
 * @returns {boolean}
 */
function canTraverseSlope(cell, entryDirIndex) {
  const def = TILE_LIST[cell.type]
  if (!def?.highEdges?.length) return true // not a slope, allow

  // The slope's road axis is E(1)-W(4) unrotated, rotated by cell.rotation.
  // Road can only enter from one of these two directions.
  const axisA = (1 + cell.rotation) % 6  // E rotated
  const axisB = (4 + cell.rotation) % 6  // W rotated
  return entryDirIndex === axisA || entryDirIndex === axisB
}

/** Simple hash-based noise in [0,1) for terminal weighting. */
function coordNoise(q, r, freq) {
  const x = q * freq
  const z = r * freq
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

// ---------------------------------------------------------------------------
// RoadRouter
// ---------------------------------------------------------------------------

export class RoadRouter {
  /**
   * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
   * @param {Map} riverCells — RiverRouter.riverCells (cubeKey → { type, riverIndex })
   * @param {Set} villageCells — VillagePlacer output (cubeKey set)
   * @param {Object} [options]
   * @param {number} [options.minTerminalDistance=3] — minimum hex distance between terminals
   * @param {number} [options.maxExpansion=1200]     — max cells expanded per Dijkstra pass
   * @param {number} [options.edgePenalty=3.0]       — cost penalty for map-edge proximity
   * @param {number} [options.riverPenalty=8.0]      — cost for crossing river without crossing tile
   * @param {number} [options.crossingReward=0.5]    — cost for using an existing crossing tile
   * @param {number} [options.maxTerminals=20]       — max number of road terminals
   * @param {number} [options.adjacencyPenalty=4.0]  — cost for stepping next to an already-committed road
   */
  constructor(globalCells, riverCells, villageCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.villageCells = villageCells || new Set()
    this.minTerminalDistance = options.minTerminalDistance ?? 3
    this.maxExpansion = options.maxExpansion ?? 1200
    this.edgePenalty = options.edgePenalty ?? 3.0
    this.riverPenalty = options.riverPenalty ?? 8.0
    this.crossingReward = options.crossingReward ?? 0.5
    this.maxTerminals = options.maxTerminals ?? 20
    this.adjacencyPenalty = options.adjacencyPenalty ?? 4.0

    /** @type {Map<string, { type: string }>} cubeKey → road cell info */
    this.roadCells = new Map()

    /** @type {Map<string, Set<number>>} cubeKey → Set<dirIndex> of road edge directions */
    this.roadEdges = new Map()
  }

  /**
   * Run the full routing pass.
   * @returns {{ roadEdges: Map, roadCells: Map }}
   */
  route() {
    this.roadCells.clear()
    this.roadEdges.clear()

    // Phase 1 — Terminal selection
    const terminals = this._selectTerminals()
    console.warn(`[ROADS] Terminals selected: ${terminals.length}`)
    if (terminals.length < 2) {
      console.warn('[ROADS] Not enough terminals to route roads')
      return { roadEdges: this.roadEdges, roadCells: this.roadCells }
    }

    const terminalSet = new Set(terminals)

    // Phase 2 — Dijkstra expansion per terminal
    // candidateEdges: array of { from, to, cost, path[] }
    const candidateEdges = []
    for (const termKey of terminals) {
      const edges = this._dijkstraExpand(termKey, terminalSet)
      candidateEdges.push(...edges)
    }
    console.warn(`[ROADS] Candidate edges: ${candidateEdges.length}`)

    if (candidateEdges.length === 0) {
      console.warn('[ROADS] No candidate edges found')
      return { roadEdges: this.roadEdges, roadCells: this.roadCells }
    }

    // Phase 3 — Kruskal's MST
    const mstEdges = this._kruskalMST(terminals, candidateEdges)
    console.warn(`[ROADS] MST edges: ${mstEdges.length}`)

    // Phase 4 — Degree-2 augmentation
    const augmentedEdges = this._augmentLeaves(terminals, mstEdges, candidateEdges)
    console.warn(`[ROADS] Total edges after augmentation: ${augmentedEdges.length}`)

    // Phase 5 — Re-route paths with adjacency awareness, then commit
    const finalEdges = this._rerouteWithMerging(augmentedEdges, terminalSet)
    this._commitPaths(terminals, finalEdges)
    console.warn(`[ROADS] Road cells: ${this.roadCells.size}`)

    return { roadEdges: this.roadEdges, roadCells: this.roadCells }
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Terminal selection
  // ---------------------------------------------------------------------------

  _selectTerminals() {
    // Build a density map: for each cell, count how many village cells are
    // within radius 2. This gives a smooth "village proximity" field.
    const villageDensity = new Map()
    for (const vk of this.villageCells) {
      const vc = parseCubeKey(vk)
      // Radius 2 splash: the village cell itself + ring-1 + ring-2
      for (let dq = -2; dq <= 2; dq++) {
        for (let dr = Math.max(-2, -dq - 2); dr <= Math.min(2, -dq + 2); dr++) {
          const ds = -dq - dr
          const nk = cubeKey(vc.q + dq, vc.r + dr, vc.s + ds)
          const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds))
          // Weight falls off with distance: 3 for self, 2 for ring-1, 1 for ring-2
          const w = 3 - dist
          villageDensity.set(nk, (villageDensity.get(nk) || 0) + w)
        }
      }
    }

    // Score candidates: prefer cells in/near villages, on walkable terrain.
    // Any cell adjacent to a village is a candidate (low threshold).
    const candidates = []
    for (const [key, cell] of this.globalCells) {
      const def = TILE_LIST[cell.type]
      if (!def) continue
      const edgeVals = Object.values(def.edges)
      // Skip water, coast, river tiles (roads don't start there)
      if (edgeVals.every(e => e === 'water')) continue
      if (edgeVals.some(e => e === 'coast')) continue
      if (edgeVals.some(e => e === 'river')) continue
      // Skip existing road tiles
      if (edgeVals.some(e => e === 'road')) continue

      const vDensity = villageDensity.get(key) || 0
      if (vDensity <= 0) continue // must be near a village

      const noise = coordNoise(cell.q, cell.r, 0.12)

      // Weight: village density dominates, noise adds variety
      const weight = vDensity + noise * 0.3

      candidates.push({ key, cell, weight })
    }

    candidates.sort((a, b) => b.weight - a.weight)

    const terminals = []
    const termCoords = []

    // First pass: place a terminal in every village cluster that doesn't
    // already have one. Track which village cells are "covered".
    const coveredVillages = new Set()

    for (const { key, cell } of candidates) {
      if (terminals.length >= this.maxTerminals) break

      // Check minimum distance from existing terminals
      let tooClose = false
      for (const tc of termCoords) {
        if (cubeDistance(cell.q, cell.r, cell.s, tc.q, tc.r, tc.s) < this.minTerminalDistance) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      terminals.push(key)
      termCoords.push({ q: cell.q, r: cell.r, s: cell.s })

      // Mark nearby village cells as covered
      for (const vk of this.villageCells) {
        const vc = parseCubeKey(vk)
        if (cubeDistance(cell.q, cell.r, cell.s, vc.q, vc.r, vc.s) <= this.minTerminalDistance) {
          coveredVillages.add(vk)
        }
      }
    }

    // Second pass: any uncovered village cluster gets a terminal even if
    // it's closer than minTerminalDistance to an existing one (but still
    // enforce distance 2 to avoid overlapping terminals).
    if (coveredVillages.size < this.villageCells.size) {
      for (const { key, cell } of candidates) {
        if (terminals.length >= this.maxTerminals) break
        if (coveredVillages.has(key)) continue

        // Must be a village cell itself (not just nearby)
        if (!this.villageCells.has(key)) continue

        // Enforce minimum distance of 2 from other terminals
        let tooClose = false
        for (const tc of termCoords) {
          if (cubeDistance(cell.q, cell.r, cell.s, tc.q, tc.r, tc.s) < 2) {
            tooClose = true
            break
          }
        }
        if (tooClose) continue

        terminals.push(key)
        termCoords.push({ q: cell.q, r: cell.r, s: cell.s })

        for (const vk of this.villageCells) {
          const vc = parseCubeKey(vk)
          if (cubeDistance(cell.q, cell.r, cell.s, vc.q, vc.r, vc.s) <= this.minTerminalDistance) {
            coveredVillages.add(vk)
          }
        }
      }
    }

    console.warn(`[ROADS] Village coverage: ${coveredVillages.size}/${this.villageCells.size} village cells covered`)
    return terminals
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Dijkstra expansion
  // ---------------------------------------------------------------------------

  /**
   * Run a full Dijkstra expansion from a terminal. When the frontier reaches
   * another terminal, record a candidate edge. Let the expansion run to
   * maxExpansion to find all reachable terminals.
   *
   * @param {string} sourceKey
   * @param {Set<string>} terminalSet
   * @returns {Array<{ from: string, to: string, cost: number, path: string[] }>}
   */
  _dijkstraExpand(sourceKey, terminalSet) {
    const source = this.globalCells.get(sourceKey)
    if (!source) return []

    const cameFrom = new Map()  // key → parentKey
    const entryDir = new Map()  // key → direction index road enters from
    const costSoFar = new Map()
    const frontier = new MinHeap()

    cameFrom.set(sourceKey, null)
    entryDir.set(sourceKey, null)
    costSoFar.set(sourceKey, 0)
    frontier.push({ key: sourceKey, cost: 0 })

    const edges = []
    let expanded = 0

    while (frontier.size > 0 && expanded < this.maxExpansion) {
      const { key: currentKey, cost: currentCost } = frontier.pop()

      if (currentCost > costSoFar.get(currentKey)) continue
      expanded++

      const current = this.globalCells.get(currentKey)
      if (!current) continue

      // If we reached another terminal, record candidate edge
      if (currentKey !== sourceKey && terminalSet.has(currentKey)) {
        const path = this._tracePath(cameFrom, currentKey)
        edges.push({ from: sourceKey, to: currentKey, cost: currentCost, path })
        // Don't stop — keep expanding to find more terminals
      }

      // Determine valid exits based on road tile geometry.
      // Roads can go straight (e+3)%6 or 120° bend (e+2)%6, (e+4)%6.
      // Same angular constraints as rivers — no 60° sharp turns.
      // Source/terminal cells (no entry direction) can exit any direction.
      const e = entryDir.get(currentKey)
      const validExits = e === null
        ? [0, 1, 2, 3, 4, 5]
        : [(e + 2) % 6, (e + 3) % 6, (e + 4) % 6]

      for (const d of validExits) {
        const dir = CUBE_DIRS[d]
        const nq = current.q + dir.dq
        const nr = current.r + dir.dr
        const ns = current.s + dir.ds
        const nk = cubeKey(nq, nr, ns)
        const neighbor = this.globalCells.get(nk)

        // Off-map
        if (!neighbor) continue

        // Already visited with same or better cost
        if (cameFrom.has(nk) && costSoFar.get(nk) <= currentCost + 0.1) continue

        const def = TILE_LIST[neighbor.type]
        if (!def) continue

        const edgeVals = Object.values(def.edges)
        const isWater = edgeVals.every(ev => ev === 'water')
        const hasCoast = edgeVals.some(ev => ev === 'coast')

        // Water/coast: impassable
        if (isWater || hasCoast) continue

        // Elevation & slope checks
        const exitEdgeLevel = edgeLevelAt(current, d)
        const oppositeDir = (d + 3) % 6
        const entryEdgeLevel = edgeLevelAt(neighbor, oppositeDir)

        // Slope tiles: roads can ONLY go straight across the slope axis
        const neighborDef = TILE_LIST[neighbor.type]
        const neighborIsSlope = neighborDef?.highEdges?.length > 0
        if (neighborIsSlope) {
          if (!canTraverseSlope(neighbor, oppositeDir)) continue
        }

        // Current cell is a slope: road can only exit along slope axis
        const currentDef = TILE_LIST[current.type]
        const currentIsSlope = currentDef?.highEdges?.length > 0
        if (currentIsSlope) {
          if (!canTraverseSlope(current, d)) continue
        }

        // Cliff check: edge levels must match (slopes already handled above)
        if (exitEdgeLevel !== entryEdgeLevel) {
          if (!neighborIsSlope) continue
        }

        // --- Cost computation ---
        let stepCost = 1.0 // base cost: flat per cell

        // River cell penalty/reward
        const isRiverCell = this.riverCells.has(nk)
        if (isRiverCell) {
          const neighborName = def.name
          if (neighborName === 'RIVER_CROSSING_A' || neighborName === 'RIVER_CROSSING_B') {
            // Existing crossing: check that road direction is compatible
            if (this._isCrossingCompatible(neighbor, d)) {
              stepCost = this.crossingReward
            } else {
              stepCost = this.riverPenalty
            }
          } else {
            // Regular river cell: heavy penalty
            stepCost = this.riverPenalty
          }
        }

        // Edge-of-map penalty
        const edgeCount = this._countEdgeNeighbors(nq, nr, ns)
        if (edgeCount > 0) {
          stepCost += this.edgePenalty * edgeCount
        }

        const newCost = currentCost + stepCost

        if (!costSoFar.has(nk) || newCost < costSoFar.get(nk)) {
          costSoFar.set(nk, newCost)
          cameFrom.set(nk, currentKey)
          entryDir.set(nk, oppositeDir)
          frontier.push({ key: nk, cost: newCost })
        }
      }
    }

    return edges
  }

  /**
   * Check whether a road in direction d is compatible with a river crossing tile.
   * RIVER_CROSSING_A: road at SE(2), NW(5); river at E(1), W(4)
   * RIVER_CROSSING_B: road at NE(0), SW(3); river at E(1), W(4)
   */
  _isCrossingCompatible(cell, roadExitDir) {
    const def = TILE_LIST[cell.type]
    if (!def) return false

    const rotatedEdges = rotateHexEdges(def.edges, cell.rotation)
    const exitDirName = CUBE_DIRS[roadExitDir].name
    const entryDirName = CUBE_DIRS[(roadExitDir + 3) % 6].name

    return rotatedEdges[exitDirName] === 'road' || rotatedEdges[entryDirName] === 'road'
  }

  /** Trace a path from goal back to source via cameFrom map. */
  _tracePath(cameFrom, goalKey) {
    const path = []
    let key = goalKey
    while (key !== null) {
      path.push(key)
      key = cameFrom.get(key)
    }
    path.reverse()
    return path
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Kruskal's MST
  // ---------------------------------------------------------------------------

  _kruskalMST(terminals, candidateEdges) {
    // Deduplicate: keep cheapest edge between each pair
    const edgeMap = new Map()
    for (const edge of candidateEdges) {
      const pairKey = [edge.from, edge.to].sort().join('|')
      if (!edgeMap.has(pairKey) || edge.cost < edgeMap.get(pairKey).cost) {
        edgeMap.set(pairKey, edge)
      }
    }

    const sortedEdges = [...edgeMap.values()].sort((a, b) => a.cost - b.cost)

    const uf = new UnionFind()
    for (const t of terminals) uf.makeSet(t)

    const mst = []
    for (const edge of sortedEdges) {
      if (uf.union(edge.from, edge.to)) {
        mst.push(edge)
      }
      // Check if all connected
      if (mst.length === terminals.length - 1) break
    }

    return mst
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Degree-2 augmentation
  // ---------------------------------------------------------------------------

  _augmentLeaves(terminals, mstEdges, candidateEdges) {
    // Count degree of each terminal in the MST
    const degree = new Map()
    for (const t of terminals) degree.set(t, 0)
    for (const edge of mstEdges) {
      degree.set(edge.from, degree.get(edge.from) + 1)
      degree.set(edge.to, degree.get(edge.to) + 1)
    }

    // For each leaf (degree 1), find its cheapest non-MST connection
    const mstPairSet = new Set()
    for (const edge of mstEdges) {
      mstPairSet.add([edge.from, edge.to].sort().join('|'))
    }

    // Deduplicate candidate edges
    const edgeMap = new Map()
    for (const edge of candidateEdges) {
      const pairKey = [edge.from, edge.to].sort().join('|')
      if (!edgeMap.has(pairKey) || edge.cost < edgeMap.get(pairKey).cost) {
        edgeMap.set(pairKey, edge)
      }
    }

    const extraEdges = []
    for (const [terminal, deg] of degree) {
      if (deg >= 2) continue

      // Find cheapest non-MST edge from this terminal
      let best = null
      for (const [pairKey, edge] of edgeMap) {
        if (mstPairSet.has(pairKey)) continue
        if (edge.from === terminal || edge.to === terminal) {
          if (!best || edge.cost < best.cost) best = edge
        }
      }

      if (best) {
        extraEdges.push(best)
        mstPairSet.add([best.from, best.to].sort().join('|'))
        degree.set(best.from, degree.get(best.from) + 1)
        degree.set(best.to, degree.get(best.to) + 1)
      }
    }

    return [...mstEdges, ...extraEdges]
  }

  // ---------------------------------------------------------------------------
  // Phase 5a — Re-route paths to merge with already-committed roads
  // ---------------------------------------------------------------------------

  /**
   * Re-route each selected edge (MST + augmentation) in cost order, using
   * a shared globalOwned map. The Dijkstra cost function penalizes cells
   * adjacent to owned roads (to prevent parallel running) and rewards cells
   * that ARE owned roads (to encourage merging).
   */
  _rerouteWithMerging(edges, terminalSet) {
    const sorted = [...edges].sort((a, b) => a.cost - b.cost)
    const globalOwned = new Set() // cells committed so far
    const result = []

    for (const edge of sorted) {
      // Re-run Dijkstra from edge.from to edge.to with adjacency awareness
      const path = this._dijkstraPointToPoint(edge.from, edge.to, globalOwned, terminalSet)
      if (path) {
        result.push({ from: edge.from, to: edge.to, cost: edge.cost, path })
        // Commit this path's cells to globalOwned
        for (const key of path) globalOwned.add(key)
      } else {
        // Fallback: use original path
        result.push(edge)
        for (const key of edge.path) globalOwned.add(key)
      }
    }

    return result
  }

  /**
   * Point-to-point Dijkstra with adjacency-aware cost function.
   * - Cells on existing roads (globalOwned): cost 0.2 (merge bonus)
   * - Cells adjacent to existing roads: cost penalty (discourages parallel)
   * - Normal cells: cost 1.0
   */
  _dijkstraPointToPoint(fromKey, toKey, globalOwned, terminalSet) {
    const source = this.globalCells.get(fromKey)
    const target = this.globalCells.get(toKey)
    if (!source || !target) return null

    const cameFrom = new Map()
    const entryDir = new Map()
    const costSoFar = new Map()
    const frontier = new MinHeap()

    cameFrom.set(fromKey, null)
    entryDir.set(fromKey, null)
    costSoFar.set(fromKey, 0)
    frontier.push({ key: fromKey, cost: 0 })

    let expanded = 0

    while (frontier.size > 0 && expanded < this.maxExpansion) {
      const { key: currentKey, cost: currentCost } = frontier.pop()

      if (currentCost > costSoFar.get(currentKey)) continue
      expanded++

      // Reached target — trace back
      if (currentKey === toKey) {
        return this._tracePath(cameFrom, toKey)
      }

      const current = this.globalCells.get(currentKey)
      if (!current) continue

      // Valid exits (tile-aware direction constraints)
      const e = entryDir.get(currentKey)
      // At terminals or on already-owned road cells, allow any exit direction
      // (the road is already established, so we can branch from it freely)
      const isOnRoad = globalOwned.has(currentKey)
      const isTerminal = terminalSet.has(currentKey)
      const validExits = (e === null || isOnRoad || isTerminal)
        ? [0, 1, 2, 3, 4, 5]
        : [(e + 2) % 6, (e + 3) % 6, (e + 4) % 6]

      for (const d of validExits) {
        const dir = CUBE_DIRS[d]
        const nq = current.q + dir.dq
        const nr = current.r + dir.dr
        const ns = current.s + dir.ds
        const nk = cubeKey(nq, nr, ns)
        const neighbor = this.globalCells.get(nk)

        if (!neighbor) continue

        const def = TILE_LIST[neighbor.type]
        if (!def) continue

        const edgeVals = Object.values(def.edges)
        if (edgeVals.every(ev => ev === 'water')) continue
        if (edgeVals.some(ev => ev === 'coast')) continue

        // Elevation & slope checks
        const exitEdgeLevel = edgeLevelAt(current, d)
        const oppositeDir = (d + 3) % 6
        const entryEdgeLvl = edgeLevelAt(neighbor, oppositeDir)

        // Slope tiles: roads can ONLY go straight across the slope axis
        const neighborDef = TILE_LIST[neighbor.type]
        const neighborIsSlope = neighborDef?.highEdges?.length > 0
        if (neighborIsSlope) {
          if (!canTraverseSlope(neighbor, oppositeDir)) continue
        }

        const currentDef = TILE_LIST[current.type]
        const currentIsSlope = currentDef?.highEdges?.length > 0
        if (currentIsSlope) {
          if (!canTraverseSlope(current, d)) continue
        }

        // Cliff check: edge levels must match
        if (exitEdgeLevel !== entryEdgeLvl) {
          if (!neighborIsSlope) continue
        }

        // --- Adjacency-aware cost ---
        let stepCost
        if (globalOwned.has(nk)) {
          // Merging into existing road: very cheap
          stepCost = 0.2
        } else {
          stepCost = 1.0

          // Penalty for running adjacent to existing roads (parallel avoidance)
          if (this._isAdjacentToOwnedRoad(nq, nr, ns, globalOwned)) {
            stepCost += this.adjacencyPenalty
          }

          // River penalty/reward
          if (this.riverCells.has(nk)) {
            const neighborName = def.name
            if (neighborName === 'RIVER_CROSSING_A' || neighborName === 'RIVER_CROSSING_B') {
              if (this._isCrossingCompatible(neighbor, d)) {
                stepCost = this.crossingReward
              } else {
                stepCost = this.riverPenalty
              }
            } else {
              stepCost = this.riverPenalty
            }
          }

          // Edge penalty
          const edgeCount = this._countEdgeNeighbors(nq, nr, ns)
          if (edgeCount > 0) stepCost += this.edgePenalty * edgeCount
        }

        const newCost = currentCost + stepCost
        if (!costSoFar.has(nk) || newCost < costSoFar.get(nk)) {
          costSoFar.set(nk, newCost)
          cameFrom.set(nk, currentKey)
          entryDir.set(nk, oppositeDir)
          frontier.push({ key: nk, cost: newCost })
        }
      }
    }

    return null // couldn't reach target
  }

  /**
   * Check if any neighbor of (q,r,s) is in the globalOwned set.
   */
  _isAdjacentToOwnedRoad(q, r, s, globalOwned) {
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      const nk = cubeKey(q + dir.dq, r + dir.dr, s + dir.ds)
      if (globalOwned.has(nk)) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Phase 5b — Path commitment and junction detection
  // ---------------------------------------------------------------------------

  _commitPaths(terminals, edges) {
    const terminalSet = new Set(terminals)

    // Sort by cost ascending — commit cheaper/more central paths first
    const sorted = [...edges].sort((a, b) => a.cost - b.cost)

    for (const edge of sorted) {
      const { path } = edge

      for (let i = 0; i < path.length; i++) {
        const key = path[i]
        const cell = this.globalCells.get(key)
        if (!cell) continue

        // Compute road directions for this cell in this path
        if (!this.roadEdges.has(key)) this.roadEdges.set(key, new Set())
        const dirs = this.roadEdges.get(key)

        if (i > 0) {
          const prevCell = this.globalCells.get(path[i - 1])
          if (prevCell) {
            const d = this._directionBetween(cell, prevCell)
            if (d >= 0) dirs.add(d)
          }
        }
        if (i < path.length - 1) {
          const nextCell = this.globalCells.get(path[i + 1])
          if (nextCell) {
            const d = this._directionBetween(cell, nextCell)
            if (d >= 0) dirs.add(d)
          }
        }

        // Preliminary type (will be refined in second pass)
        if (!this.roadCells.has(key)) {
          if (terminalSet.has(key)) {
            this.roadCells.set(key, { type: RoadCellType.TERMINAL })
          } else {
            this.roadCells.set(key, { type: RoadCellType.PATH })
          }
        }
      }
    }

    // Second pass: classify cells based on their final direction count.
    // A junction is a cell with 3+ road directions (a genuine T or cross).
    // A cell with 2 directions that was visited by multiple paths is just
    // a shared road segment, not a junction.
    for (const [key, info] of this.roadCells) {
      const dirs = this.roadEdges.get(key)
      if (!dirs) continue

      if (dirs.size >= 3) {
        this.roadCells.set(key, { type: RoadCellType.JUNCTION })
      } else if (terminalSet.has(key)) {
        if (dirs.size === 1) {
          this.roadCells.set(key, { type: RoadCellType.ROAD_END })
        } else {
          this.roadCells.set(key, { type: RoadCellType.TERMINAL })
        }
      }
      // dirs.size <= 2 non-terminal → stays PATH
    }
  }

  // ---------------------------------------------------------------------------
  // computeReplacements() — tile selection (Phase 6, for later)
  // ---------------------------------------------------------------------------

  /**
   * Compute tile replacements for all routed roads.
   * Must be called after route().
   *
   * @returns {{ replacements: Array<{ q, r, s, type, rotation, level }> }}
   */
  computeReplacements() {
    const replacements = []
    let replaced = 0, skipped = 0

    for (const [key, dirs] of this.roadEdges) {
      const cell = this.globalCells.get(key)
      if (!cell) continue

      // Check if this is a river crossing
      const isRiverCell = this.riverCells.has(key)
      if (isRiverCell) {
        const match = this._selectCrossingTile(cell, dirs)
        if (match) {
          replacements.push({
            q: cell.q, r: cell.r, s: cell.s,
            type: match.type, rotation: match.rotation, level: cell.level,
          })
          replaced++
        } else {
          skipped++
        }
        continue
      }

      // Check if this is a slope cell
      const def = TILE_LIST[cell.type]
      if (def?.highEdges?.length > 0) {
        const match = this._selectSlopeTile(cell, dirs)
        if (match) {
          replacements.push({
            q: cell.q, r: cell.r, s: cell.s,
            type: match.type, rotation: match.rotation, level: cell.level,
          })
          replaced++
        } else {
          skipped++
        }
        continue
      }

      const match = selectRoadTile(dirs)
      if (!match) {
        skipped++
        continue
      }

      replacements.push({
        q: cell.q, r: cell.r, s: cell.s,
        type: match.type, rotation: match.rotation, level: cell.level,
      })
      replaced++
    }

    console.warn(`[ROADS] Tile replacements: ${replaced} replaced, ${skipped} skipped`)
    return { replacements }
  }

  /**
   * Select a river crossing tile for a cell that has both road and river.
   * RIVER_CROSSING_A: river E,W + road SE,NW (unrotated)
   * RIVER_CROSSING_B: river E,W + road NE,SW (unrotated)
   */
  _selectCrossingTile(cell, roadDirs) {
    if (roadDirs.size !== 2) return null

    const [a, b] = [...roadDirs].sort((x, y) => x - y)
    const sep = Math.min(b - a, 6 - (b - a))
    if (sep !== 3) return null // roads must be opposite (straight through)

    // Try RIVER_CROSSING_A: road at SE(2), NW(5) unrotated
    for (let r = 0; r < 6; r++) {
      const rd0 = (2 + r) % 6, rd1 = (5 + r) % 6
      if ((rd0 === a && rd1 === b) || (rd0 === b && rd1 === a)) {
        return { type: TileType.RIVER_CROSSING_A, rotation: r }
      }
    }
    // Try RIVER_CROSSING_B: road at NE(0), SW(3) unrotated
    for (let r = 0; r < 6; r++) {
      const rd0 = (0 + r) % 6, rd1 = (3 + r) % 6
      if ((rd0 === a && rd1 === b) || (rd0 === b && rd1 === a)) {
        return { type: TileType.RIVER_CROSSING_B, rotation: r }
      }
    }
    return null
  }

  /**
   * Select a road slope tile for slope cells.
   * ROAD_A_SLOPE_LOW/HIGH: road at E(1), W(4) unrotated, high edges NE,E,SE
   */
  _selectSlopeTile(cell, roadDirs) {
    if (roadDirs.size !== 2) return null

    const [a, b] = [...roadDirs].sort((x, y) => x - y)
    const sep = Math.min(b - a, 6 - (b - a))
    if (sep !== 3) return null // must be straight

    // Road goes E(1)-W(4) unrotated. rotation = (a - 1 + 6) % 6
    const rotation = (a - 1 + 6) % 6

    const def = TILE_LIST[cell.type]
    const levelInc = def?.levelIncrement ?? 1
    const type = levelInc >= 2 ? TileType.ROAD_A_SLOPE_HIGH : TileType.ROAD_A_SLOPE_LOW
    return { type, rotation }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  _countEdgeNeighbors(q, r, s) {
    let count = 0
    for (let d = 0; d < 6; d++) {
      const dir = CUBE_DIRS[d]
      const nk = cubeKey(q + dir.dq, r + dir.dr, s + dir.ds)
      if (!this.globalCells.has(nk)) count++
    }
    return count
  }

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
}

// ---------------------------------------------------------------------------
// Road tile selection — pure function mapping direction sets to tile+rotation
// ---------------------------------------------------------------------------

/**
 * Road tile templates (direction indices where road edges exist unrotated).
 * Direction indices: 0=NE, 1=E, 2=SE, 3=SW, 4=W, 5=NW
 */
const ROAD_TILES_3 = [
  { type: TileType.ROAD_D, dirs: [0, 2, 4] },  // NE, SE, W — evenly spaced
  { type: TileType.ROAD_E, dirs: [0, 1, 4] },  // NE, E, W — two adjacent + one opposite
  { type: TileType.ROAD_F, dirs: [1, 2, 4] },  // E, SE, W — two adjacent + one opposite
]

/**
 * Given a set of required road direction indices, find the best tile type
 * and rotation.
 *
 * @param {Set<number>} requiredDirs — direction indices (0–5) needing road edges
 * @returns {{ type: number, rotation: number } | null}
 */
function selectRoadTile(requiredDirs) {
  const n = requiredDirs.size

  if (n === 0) return null

  // 1 edge — ROAD_END (unrotated road edge at index 4 = W)
  if (n === 1) {
    const dir = requiredDirs.values().next().value
    const rotation = (dir - 4 + 6) % 6
    return { type: TileType.ROAD_END, rotation }
  }

  // 2 edges
  if (n === 2) {
    const [a, b] = [...requiredDirs].sort((x, y) => x - y)
    const sep = Math.min(b - a, 6 - (b - a))

    if (sep === 3) {
      // Straight (180°) — ROAD_A: road edges at E(1), W(4) unrotated
      const rotation = (a - 1 + 6) % 6
      return { type: TileType.ROAD_A, rotation }
    }

    if (sep === 2) {
      // 120° bend — ROAD_B: road edges at NE(0), W(4) unrotated
      for (const flip of [false, true]) {
        const d0 = flip ? b : a
        const d1 = flip ? a : b
        const r = (d0 - 0 + 6) % 6
        if ((4 + r) % 6 === d1) return { type: TileType.ROAD_B, rotation: r }
      }
      return null
    }

    // sep === 1 (60° — no valid tile)
    return null
  }

  // 3 edges — T-junctions
  if (n === 3) {
    const sorted = [...requiredDirs].sort((x, y) => x - y)

    for (const template of ROAD_TILES_3) {
      const match = matchTile3(sorted, template.dirs)
      if (match !== null) return { type: template.type, rotation: match }
    }

    // Fallback to ROAD_D
    const rotation = (sorted[0] - 0 + 6) % 6
    return { type: TileType.ROAD_D, rotation }
  }

  // 4+ edges — no tiles exist, use ROAD_D as best approximation
  if (n >= 4) {
    const dir = requiredDirs.values().next().value
    const rotation = (dir - 0 + 6) % 6
    return { type: TileType.ROAD_D, rotation }
  }

  return null
}

/**
 * Try to find a rotation r such that rotating the template's direction set
 * produces exactly the required direction set.
 */
function matchTile3(required, template) {
  for (let r = 0; r < 6; r++) {
    const rotated = template.map(d => (d + r) % 6).sort((a, b) => a - b)
    if (rotated[0] === required[0] && rotated[1] === required[1] && rotated[2] === required[2]) {
      return r
    }
  }
  return null
}
