/**
 * ForestPlacer — post-WFC forest zone identification (Step 4)
 *
 * Samples the same global noise fields (globalNoiseA/B) used by the
 * Decorations tree system to identify which cells should be forested.
 * The noise defines the base structure; biases for elevation and river
 * proximity adjust the threshold per-cell.
 *
 * Produces a Set<cubeKey> consumed by Decorations.populate().
 */

import { cubeKey, cubeToOffset, CUBE_DIRS, cubeDistance, parseCubeKey } from './HexWFCCore.js'
import { TILE_LIST, TileType } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import { globalNoiseA, globalNoiseB, getCurrentTreeThreshold } from './DecorationDefs.js'

export class ForestPlacer {
  /**
   * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
   * @param {Map} riverCells  — RiverRouter.riverCells (cubeKey → info), may be empty
   * @param {Object} [options]
   * @param {number} [options.riverBonus=0.1]       — threshold reduction for cells near rivers
   * @param {number} [options.riverBonusRange=3]    — max hex distance for river proximity bonus
   * @param {number} [options.idealLevel=1]         — preferred elevation for forests
   * @param {number} [options.levelPenalty=0.05]    — threshold increase per level away from idealLevel
   */
  constructor(globalCells, riverCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.riverBonus = options.riverBonus ?? 0.1
    this.riverBonusRange = options.riverBonusRange ?? 3
    this.idealLevel = options.idealLevel ?? 1
    this.levelPenalty = options.levelPenalty ?? 0.05
  }

  /**
   * Identify forest zone cells by sampling the global tree noise.
   * @returns {Set<string>} cubeKeys of cells that should have forests
   */
  place() {
    if (!globalNoiseA || !globalNoiseB) {
      console.warn('[FORESTS] Global noise not initialized, skipping')
      return new Set()
    }

    const baseThreshold = getCurrentTreeThreshold()
    const forestCells = new Set()

    // Pre-collect river cell positions for proximity checks
    const riverPositions = []
    for (const key of this.riverCells.keys()) {
      riverPositions.push(parseCubeKey(key))
    }

    for (const [key, cell] of this.globalCells) {
      // Only flat grass tiles
      if (cell.type !== TileType.GRASS) continue

      // Skip cells that are river cells
      if (this.riverCells.has(key)) continue

      // Skip coast-adjacent cells
      if (this._hasCoastNeighbor(cell)) continue

      // Convert cube coords → world position for noise sampling
      const offset = cubeToOffset(cell.q, cell.r, cell.s)
      const worldPos = HexTileGeometry.getWorldPosition(offset.col, offset.row)

      // Sample the same noise fields Decorations uses
      const noiseA = globalNoiseA.scaled2D(worldPos.x, worldPos.z)
      const noiseB = globalNoiseB.scaled2D(worldPos.x, worldPos.z)
      const noiseMax = Math.max(noiseA, noiseB)

      // Per-cell threshold: start from the global tree threshold, then adjust
      let threshold = baseThreshold

      // Elevation bias: penalize distance from ideal level
      const levelDist = Math.abs(cell.level - this.idealLevel)
      threshold += levelDist * this.levelPenalty

      // River proximity bonus: lower threshold near rivers
      if (riverPositions.length > 0) {
        let minDist = Infinity
        for (const rp of riverPositions) {
          const d = cubeDistance(cell.q, cell.r, cell.s, rp.q, rp.r, rp.s)
          if (d < minDist) minDist = d
        }
        if (minDist <= this.riverBonusRange) {
          threshold -= this.riverBonus * (1 - minDist / (this.riverBonusRange + 1))
        }
      }

      if (noiseMax >= threshold) {
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
