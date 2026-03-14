/**
 * VillagePlacer — post-WFC village zone identification (Step 5)
 *
 * After forests are placed, identifies cells that should have villages.
 * Uses noise + proximity scoring biased toward rivers and flat terrain.
 * Picks village centers with minimum spacing, then expands each center
 * into a small cluster of nearby eligible cells. Produces a Set<cubeKey>
 * consumed by the Decorations system.
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance } from './HexWFCCore.js'
import { TILE_LIST, TileType } from './HexTileData.js'

/** Hash-based noise in [0,1). */
function coordNoise(q, r, freq, seed = 0) {
  const x = q * freq + seed
  const z = r * freq
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export class VillagePlacer {
  /**
   * @param {Map} globalCells  — HexMap.globalCells (cubeKey → cell)
   * @param {Map} riverCells   — RiverRouter.riverCells (cubeKey → info)
   * @param {Set} forestCells  — ForestPlacer output (cubeKeys)
   * @param {Object} [options]
   * @param {number} [options.noiseFreq=0.04]         — noise frequency
   * @param {number} [options.threshold=0.45]         — score threshold for center eligibility
   * @param {number} [options.riverBonus=0.3]         — score bonus for river proximity
   * @param {number} [options.riverBonusRange=4]      — max hex distance for river bonus
   * @param {number} [options.minVillageDistance=6]    — minimum hex distance between village centers
   * @param {number} [options.clusterRadius=1]        — hex radius around center to include in village
   * @param {number} [options.maxLevel=1]             — villages prefer flat areas ≤ this level
   * @param {number} [options.highLevelPenalty=0.2]    — penalty per level above maxLevel
   */
  constructor(globalCells, riverCells, forestCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.forestCells = forestCells || new Set()
    this.noiseFreq = options.noiseFreq ?? 0.04
    this.threshold = options.threshold ?? 0.45
    this.riverBonus = options.riverBonus ?? 0.3
    this.riverBonusRange = options.riverBonusRange ?? 4
    this.minVillageDistance = options.minVillageDistance ?? 6
    this.clusterRadius = options.clusterRadius ?? 1
    this.maxLevel = options.maxLevel ?? 1
    this.highLevelPenalty = options.highLevelPenalty ?? 0.2
  }

  /**
   * Identify village zone cells.
   * @returns {Set<string>} cubeKeys of cells suitable for village buildings
   */
  place() {
    // Pre-collect river positions
    const riverPositions = []
    for (const key of this.riverCells.keys()) {
      riverPositions.push(parseCubeKey(key))
    }

    // Score all candidate cells for village centers
    const candidates = []

    for (const [key, cell] of this.globalCells) {
      if (!this._isEligible(key, cell)) continue

      let score = coordNoise(cell.q, cell.r, this.noiseFreq, 99)

      // Elevation penalty for high terrain
      if (cell.level > this.maxLevel) {
        score -= (cell.level - this.maxLevel) * this.highLevelPenalty
      }

      // River proximity bonus (big bonus — villages like being near water)
      if (riverPositions.length > 0) {
        let minDist = Infinity
        for (const rp of riverPositions) {
          const d = cubeDistance(cell.q, cell.r, cell.s, rp.q, rp.r, rp.s)
          if (d < minDist) minDist = d
        }
        if (minDist <= this.riverBonusRange) {
          score += this.riverBonus * (1 - minDist / (this.riverBonusRange + 1))
        }
      }

      if (score >= this.threshold) {
        candidates.push({ key, cell, score })
      }
    }

    // Sort by score descending, then greedily pick centers enforcing min distance
    candidates.sort((a, b) => b.score - a.score)

    const villageCells = new Set()
    const centers = [] // { q, r, s } of placed village centers

    for (const { key, cell } of candidates) {
      // Enforce minimum distance from other village centers
      let tooClose = false
      for (const p of centers) {
        if (cubeDistance(cell.q, cell.r, cell.s, p.q, p.r, p.s) < this.minVillageDistance) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      // Add center
      villageCells.add(key)
      centers.push({ q: cell.q, r: cell.r, s: cell.s })

      // Expand cluster: add eligible neighbors within clusterRadius
      for (const dir of CUBE_DIRS) {
        const nq = cell.q + dir.dq
        const nr = cell.r + dir.dr
        const ns = cell.s + dir.ds
        const nk = cubeKey(nq, nr, ns)
        const neighbor = this.globalCells.get(nk)
        if (neighbor && this._isEligible(nk, neighbor)) {
          villageCells.add(nk)
        }
      }
    }

    return villageCells
  }

  /** Check if a cell is eligible for village placement. */
  _isEligible(key, cell) {
    if (cell.type !== TileType.GRASS) return false
    if (this.riverCells.has(key)) return false
    if (this.forestCells.has(key)) return false
    if (this._hasCoastNeighbor(cell)) return false
    return true
  }

  /** Check if any neighbor is coast or water. */
  _hasCoastNeighbor(cell) {
    for (const dir of CUBE_DIRS) {
      const nk = cubeKey(cell.q + dir.dq, cell.r + dir.dr, cell.s + dir.ds)
      const neighbor = this.globalCells.get(nk)
      if (!neighbor) continue
      const def = TILE_LIST[neighbor.type]
      if (def && (def.name.startsWith('COAST_') || def.name === 'WATER')) return true
    }
    return false
  }
}
