/**
 * RiverRouter — post-WFC river placement (Step 2 of the two-pass river system)
 *
 * After WFC completes, routes rivers downhill from high-elevation sources to
 * coast/water/map-edge using greedy descent in cube coordinates.
 *
 * Does NOT replace tiles yet — only computes paths for debug visualisation.
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance, getEdgeLevel } from './HexWFCCore.js'
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

/**
 * Effective elevation of a cell, accounting for slope tiles.
 * For a flat tile this is just cell.level (0–4).
 * For a slope tile the "average" elevation is baseLevel + 0.5 * increment,
 * but for river routing we care about whether water can flow, so we use the
 * maximum edge level (water sits at the high side of a slope).
 */
function cellElevation(cell) {
  const def = TILE_LIST[cell.type]
  if (!def?.highEdges?.length) return cell.level

  // For slopes, use base level — water flows off the low side
  return cell.level
}

/**
 * Get the effective elevation a neighbor sees across the shared edge.
 * This accounts for slopes: a slope tile's edge level may be higher than its
 * base level on the "high" side.
 */
function edgeLevelAt(cell, dirIndex) {
  const dirName = CUBE_DIRS[dirIndex].name
  return getEdgeLevel(cell.type, cell.rotation, dirName, cell.level)
}

/**
 * Simple 2D value noise for source probability weighting.
 * Uses a hash of cube coordinates to produce a [0,1) value.
 */
function coordNoise(q, r, freq) {
  // Simple hash-based noise
  const x = q * freq
  const z = r * freq
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export class RiverRouter {
  /**
   * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
   * @param {Object} [options]
   * @param {number} [options.minSourceLevel=3]     — minimum cell level for source placement
   * @param {number} [options.minSourceDistance=6]   — minimum hex distance between sources
   * @param {number} [options.noiseFreq=0.08]        — frequency of source probability noise
   * @param {number} [options.maxSteps=200]          — discard river if it exceeds this many steps
   * @param {number} [options.jitter=0.3]            — noise amplitude added to neighbor elevation for meanders
   */
  constructor(globalCells, options = {}) {
    this.globalCells = globalCells
    this.minSourceLevel = options.minSourceLevel ?? 2
    this.minSourceDistance = options.minSourceDistance ?? 6
    this.noiseFreq = options.noiseFreq ?? 0.08
    this.maxSteps = options.maxSteps ?? 200
    this.jitter = options.jitter ?? 0.3

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

    const sources = this._selectSources()
    for (let i = 0; i < sources.length; i++) {
      this._routeRiver(sources[i], i)
    }

    return { rivers: this.rivers, riverCells: this.riverCells }
  }

  // ---------------------------------------------------------------------------
  // Source selection
  // ---------------------------------------------------------------------------

  /**
   * Select river source cells among high-elevation land cells, weighted by a
   * noise field and enforcing a minimum distance between sources.
   * @returns {string[]} array of cubeKey strings
   */
  _selectSources() {
    // Collect candidates: land cells at minSourceLevel or above
    const candidates = []
    const levelCounts = new Map() // diagnostic
    for (const [key, cell] of this.globalCells) {
      const level = cellElevation(cell)
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1)

      if (level < this.minSourceLevel) continue

      // Exclude water/coast tiles
      const def = TILE_LIST[cell.type]
      if (!def) continue
      const edgeVals = Object.values(def.edges)
      const isWater = edgeVals.every(e => e === 'water')
      const hasCoast = edgeVals.some(e => e === 'coast')
      if (isWater || hasCoast) continue

      // Exclude tiles with river edges (already a river tile from WFC)
      const hasRiver = edgeVals.some(e => e === 'river')
      if (hasRiver) continue

      // Weight by elevation and noise
      const noise = coordNoise(cell.q, cell.r, this.noiseFreq)
      const weight = level * noise
      candidates.push({ key, cell, weight })
    }

    // Log elevation distribution for debugging
    const dist = [...levelCounts.entries()].sort((a, b) => a[0] - b[0])
      .map(([l, c]) => `L${l}:${c}`).join(' ')
    console.log(`[RIVERS] Elevation distribution: ${dist}, candidates (level≥${this.minSourceLevel}): ${candidates.length}`)

    // Sort by weight descending — greedily pick, enforcing min distance
    candidates.sort((a, b) => b.weight - a.weight)

    const sources = []
    const sourceCoords = [] // {q,r,s} for distance checks

    for (const { key, cell } of candidates) {
      // Check minimum distance from already-selected sources
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
  // Flow routing
  // ---------------------------------------------------------------------------

  /**
   * Route a single river from source downhill until termination.
   * @param {string} sourceKey — cubeKey of source cell
   * @param {number} riverIndex — index of this river (for confluence detection)
   */
  _routeRiver(sourceKey, riverIndex) {
    const path = [sourceKey]
    let endType = RiverCellType.BASIN_END // default if we get stuck

    // Mark source
    this.riverCells.set(sourceKey, { type: RiverCellType.SOURCE, riverIndex })

    let currentKey = sourceKey
    let prevDirIndex = -1 // direction we came from (for momentum tiebreaker)

    for (let step = 0; step < this.maxSteps; step++) {
      const current = this.globalCells.get(currentKey)
      if (!current) break

      const currentElev = cellElevation(current)

      // Evaluate all 6 neighbors
      const neighbors = []
      for (let d = 0; d < 6; d++) {
        const dir = CUBE_DIRS[d]
        const nq = current.q + dir.dq
        const nr = current.r + dir.dr
        const ns = current.s + dir.ds
        const nk = cubeKey(nq, nr, ns)
        const neighbor = this.globalCells.get(nk)

        if (!neighbor) {
          // Map edge — valid termination
          neighbors.push({ key: nk, dirIndex: d, elev: -Infinity, isEdge: true, isWater: false, isCoast: false })
          continue
        }

        const def = TILE_LIST[neighbor.type]
        if (!def) continue

        const edgeVals = Object.values(def.edges)
        const isWater = edgeVals.every(e => e === 'water')
        const hasCoast = edgeVals.some(e => e === 'coast')

        // The effective elevation the river "sees" crossing this edge
        // Use the edge level from the current cell's side
        const exitEdgeLevel = edgeLevelAt(current, d)
        const neighborElev = cellElevation(neighbor)

        // Effective elevation for comparison: use max of neighbor base and entry edge
        const effectiveElev = neighborElev

        neighbors.push({
          key: nk,
          dirIndex: d,
          elev: effectiveElev,
          exitEdgeLevel,
          isEdge: false,
          isWater,
          isCoast: isCoast || hasCoast,
        })
      }

      // --- Termination checks ---

      // Check for coast or water neighbors (prefer these as endpoints)
      const coastOrWater = neighbors.filter(n => !n.isEdge && (n.isWater || n.isCoast))
      if (coastOrWater.length > 0) {
        // Pick the closest coast/water
        const target = coastOrWater[0]
        path.push(target.key)
        endType = RiverCellType.COAST_END
        this.riverCells.set(target.key, { type: RiverCellType.COAST_END, riverIndex })
        break
      }

      // Check for map edge
      const edgeNeighbors = neighbors.filter(n => n.isEdge)

      // --- Pick best downhill neighbor ---
      const validNeighbors = neighbors.filter(n => !n.isEdge && !n.isWater && !n.isCoast)

      // Partition into downhill, flat, and uphill
      const downhill = validNeighbors.filter(n => n.elev < currentElev)
      const flat = validNeighbors.filter(n => n.elev === currentElev)

      let best = null

      if (downhill.length > 0) {
        best = this._pickBest(downhill, prevDirIndex)
      } else if (flat.length > 0) {
        best = this._pickBest(flat, prevDirIndex)
      } else if (edgeNeighbors.length > 0) {
        // All land neighbors are uphill — flow off edge
        path.push(edgeNeighbors[0].key)
        endType = RiverCellType.EDGE_END
        break
      } else {
        // Landlocked basin — no downhill, no flat, no edge
        endType = RiverCellType.BASIN_END
        this.riverCells.set(currentKey, { type: RiverCellType.BASIN_END, riverIndex })
        break
      }

      if (!best) {
        endType = RiverCellType.BASIN_END
        break
      }

      // --- Confluence check ---
      const existing = this.riverCells.get(best.key)
      if (existing && existing.riverIndex !== riverIndex) {
        // Merge into existing river
        path.push(best.key)
        endType = RiverCellType.CONFLUENCE
        this.riverCells.set(best.key, { type: RiverCellType.CONFLUENCE, riverIndex: existing.riverIndex })
        break
      }

      // --- Loop detection ---
      if (this.riverCells.has(best.key) && this.riverCells.get(best.key).riverIndex === riverIndex) {
        // Would loop into our own path — terminate as basin
        endType = RiverCellType.BASIN_END
        this.riverCells.set(currentKey, { type: RiverCellType.BASIN_END, riverIndex })
        break
      }

      // Advance
      path.push(best.key)
      this.riverCells.set(best.key, { type: RiverCellType.PATH, riverIndex })
      prevDirIndex = best.dirIndex
      currentKey = best.key
    }

    // If we hit maxSteps, discard the river
    if (path.length >= this.maxSteps) {
      for (const key of path) {
        this.riverCells.delete(key)
      }
      return
    }

    this.rivers.push({ source: sourceKey, path, endType })
  }

  /**
   * Pick the best neighbor from a list, using momentum and jitter tiebreakers.
   * @param {Array} candidates — neighbor objects with { key, dirIndex, elev }
   * @param {number} prevDirIndex — direction index we came from (-1 if none)
   * @returns {Object|null} best candidate
   */
  _pickBest(candidates, prevDirIndex) {
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]

    // Score each candidate: lower is better
    // Base score = elevation
    // Momentum bonus: subtract a small amount if continuing in same direction
    // Jitter: add noise to break ties
    let bestScore = Infinity
    let best = null

    for (const c of candidates) {
      let score = c.elev

      // Momentum: prefer continuing same direction
      if (prevDirIndex >= 0 && c.dirIndex === prevDirIndex) {
        score -= 0.4
      }
      // Slight preference for adjacent directions (gentle curves)
      if (prevDirIndex >= 0) {
        const diff = Math.abs(c.dirIndex - prevDirIndex)
        const angleDist = Math.min(diff, 6 - diff)
        if (angleDist === 1) score -= 0.2
      }

      // Jitter
      score += (random() - 0.5) * this.jitter

      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }

    return best
  }
}
