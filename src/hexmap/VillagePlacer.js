/**
 * VillagePlacer — post-WFC village zone identification (Step 5)
 *
 * Samples the same global noise field (globalNoiseC) used by the
 * Decorations building system to identify which cells should have
 * villages. The noise defines the base structure; biases for river
 * proximity and elevation adjust the threshold per-cell.
 *
 * Picks village centers with minimum spacing, then expands each into
 * a small cluster. Produces a Set<cubeKey> consumed by Decorations.
 */

import { cubeKey, cubeToOffset, parseCubeKey, CUBE_DIRS, cubeDistance } from './HexWFCCore.js'
import { TILE_LIST, TileType } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import { globalNoiseC, getBuildingThreshold } from './DecorationDefs.js'

export class VillagePlacer {
  /**
   * @param {Map} globalCells  — HexMap.globalCells (cubeKey → cell)
   * @param {Map} riverCells   — RiverRouter.riverCells (cubeKey → info)
   * @param {Set} forestCells  — ForestPlacer output (cubeKeys)
   * @param {Object} [options]
   * @param {number} [options.riverBonus=0.15]        — threshold reduction for river proximity
   * @param {number} [options.riverBonusRange=4]      — max hex distance for river bonus
   * @param {number} [options.minVillageDistance=6]    — minimum hex distance between village centers
   * @param {number} [options.clusterRadius=1]        — hex radius around center to include in village
   * @param {number} [options.maxLevel=1]             — villages prefer flat areas ≤ this level
   * @param {number} [options.highLevelPenalty=0.1]   — threshold increase per level above maxLevel
   */
  constructor(globalCells, riverCells, forestCells, options = {}) {
    this.globalCells = globalCells
    this.riverCells = riverCells || new Map()
    this.forestCells = forestCells || new Set()
    this.riverBonus = options.riverBonus ?? 0.15
    this.riverBonusRange = options.riverBonusRange ?? 4
    this.minVillageDistance = options.minVillageDistance ?? 6
    this.clusterRadius = options.clusterRadius ?? 1
    this.maxLevel = options.maxLevel ?? 1
    this.highLevelPenalty = options.highLevelPenalty ?? 0.1
  }

  /**
   * Identify village zone cells by sampling the global building noise.
   * @returns {Set<string>} cubeKeys of cells suitable for village buildings
   */
  place() {
    if (!globalNoiseC) {
      console.warn('[VILLAGES] Global noise not initialized, skipping')
      return new Set()
    }

    const baseThreshold = getBuildingThreshold()

    // Pre-collect river positions
    const riverPositions = []
    for (const key of this.riverCells.keys()) {
      riverPositions.push(parseCubeKey(key))
    }

    // Score all candidate cells for village centers
    const candidates = []

    for (const [key, cell] of this.globalCells) {
      if (!this._isEligible(key, cell)) continue

      // Convert cube coords → world position for noise sampling
      const offset = cubeToOffset(cell.q, cell.r, cell.s)
      const worldPos = HexTileGeometry.getWorldPosition(offset.col, offset.row)

      // Sample the same noise field Decorations uses for buildings
      const noise = globalNoiseC.scaled2D(worldPos.x, worldPos.z)

      // Per-cell threshold: start from global building threshold, then adjust
      let threshold = baseThreshold

      // Elevation penalty for high terrain
      if (cell.level > this.maxLevel) {
        threshold += (cell.level - this.maxLevel) * this.highLevelPenalty
      }

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

      if (noise >= threshold) {
        candidates.push({ key, cell, noise })
      }
    }

    // Sort by noise value descending, then greedily pick centers enforcing min distance
    candidates.sort((a, b) => b.noise - a.noise)

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
