/**
 * VillagePlacer — post-WFC village zone identification (Step 5)
 *
 * After forests are placed, identifies cells that should have villages.
 * Uses noise + proximity scoring biased toward rivers and flat terrain.
 * Enforces minimum distance between villages. Produces a Set<cubeKey>
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
   * @param {number} [options.threshold=0.55]         — score threshold for village eligibility
   * @param {number} [options.riverBonus=0.3]         — score bonus for river proximity
   * @param {number} [options.riverBonusRange=3]      — max hex distance for river bonus
   * @param {number} [options.minVillageDistance=5]    — minimum hex distance between villages
   * @param {number} [options.maxLevel=1]             — villages prefer flat areas ≤ this level
   * @param {number} [options.highLevelPenalty=0.2]    — penalty per level above maxLevel
   */
  constructor(globalCells, riverCells, forestCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.forestCells = forestCells || new Set()
    this.noiseFreq = options.noiseFreq ?? 0.04
    this.threshold = options.threshold ?? 0.55
    this.riverBonus = options.riverBonus ?? 0.3
    this.riverBonusRange = options.riverBonusRange ?? 3
    this.minVillageDistance = options.minVillageDistance ?? 5
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

    // Score all candidate cells
    const candidates = []

    for (const [key, cell] of this.globalCells) {
      if (cell.type !== TileType.GRASS) continue
      if (this.riverCells.has(key)) continue
      if (this.forestCells.has(key)) continue
      if (this._hasCoastNeighbor(cell)) continue

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

    // Sort by score descending, then greedily pick enforcing min distance
    candidates.sort((a, b) => b.score - a.score)

    const villageCells = new Set()
    const placed = [] // { q, r, s } of placed village cells

    for (const { key, cell } of candidates) {
      // Enforce minimum distance from other villages
      let tooClose = false
      for (const p of placed) {
        if (cubeDistance(cell.q, cell.r, cell.s, p.q, p.r, p.s) < this.minVillageDistance) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      villageCells.add(key)
      placed.push({ q: cell.q, r: cell.r, s: cell.s })
    }

    return villageCells
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
