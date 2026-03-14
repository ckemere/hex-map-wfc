/**
 * ForestPlacer — post-WFC forest zone identification (Step 4)
 *
 * After rivers are routed, identifies cells that should be forested.
 * Uses noise-weighted scoring with biases for mid-elevation and river
 * proximity. Produces a Set<cubeKey> consumed by the Decorations system.
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance } from './HexWFCCore.js'
import { TILE_LIST, TileType } from './HexTileData.js'

/** Hash-based noise in [0,1) — same pattern as RiverRouter. */
function coordNoise(q, r, freq, seed = 0) {
  const x = q * freq + seed
  const z = r * freq
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export class ForestPlacer {
  /**
   * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
   * @param {Map} riverCells  — RiverRouter.riverCells (cubeKey → info), may be empty
   * @param {Object} [options]
   * @param {number} [options.noiseFreq=0.06]      — noise frequency for clustering
   * @param {number} [options.threshold=0.35]      — noise threshold for forest eligibility
   * @param {number} [options.riverBonus=0.15]     — score bonus for cells near rivers (within riverBonusRange)
   * @param {number} [options.riverBonusRange=3]   — max hex distance for river proximity bonus
   * @param {number} [options.idealLevel=1]        — preferred elevation for forests
   * @param {number} [options.levelPenalty=0.1]    — penalty per level away from idealLevel
   */
  constructor(globalCells, riverCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.noiseFreq = options.noiseFreq ?? 0.06
    this.threshold = options.threshold ?? 0.35
    this.riverBonus = options.riverBonus ?? 0.15
    this.riverBonusRange = options.riverBonusRange ?? 3
    this.idealLevel = options.idealLevel ?? 1
    this.levelPenalty = options.levelPenalty ?? 0.1
  }

  /**
   * Identify forest zone cells.
   * @returns {Set<string>} cubeKeys of cells that should have forests
   */
  place() {
    const forestCells = new Set()

    // Pre-collect river cell positions for proximity checks
    const riverPositions = []
    for (const key of this.riverCells.keys()) {
      const coords = parseCubeKey(key)
      riverPositions.push(coords)
    }

    for (const [key, cell] of this.globalCells) {
      // Only flat grass tiles
      if (cell.type !== TileType.GRASS) continue

      // Skip cells that are river cells
      if (this.riverCells.has(key)) continue

      // Skip coast-adjacent cells
      if (this._hasCoastNeighbor(cell)) continue

      // Base score from noise
      const noise = coordNoise(cell.q, cell.r, this.noiseFreq)
      let score = noise

      // Second noise octave for more natural clustering
      const noise2 = coordNoise(cell.q, cell.r, this.noiseFreq * 2.5, 42)
      score = score * 0.7 + noise2 * 0.3

      // Elevation preference: penalize distance from ideal level
      const levelDist = Math.abs(cell.level - this.idealLevel)
      score -= levelDist * this.levelPenalty

      // River proximity bonus
      if (riverPositions.length > 0) {
        let minDist = Infinity
        for (const rp of riverPositions) {
          const d = cubeDistance(cell.q, cell.r, cell.s, rp.q, rp.r, rp.s)
          if (d < minDist) minDist = d
        }
        if (minDist <= this.riverBonusRange) {
          // Closer = bigger bonus, but not ON the river (minDist > 0 guaranteed by riverCells skip above)
          score += this.riverBonus * (1 - minDist / (this.riverBonusRange + 1))
        }
      }

      if (score >= this.threshold) {
        forestCells.add(key)
      }
    }

    return forestCells
  }

  /** Check if any neighbor of a cell is coast or water. */
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
