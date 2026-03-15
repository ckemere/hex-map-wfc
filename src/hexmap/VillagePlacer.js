/**
 * VillagePlacer — post-WFC village zone identification (Step 5)
 *
 * Thresholds the terrain-shaped village density field produced by
 * TerrainNoise.buildTerrainDensity(). All terrain awareness is baked
 * into the density values.
 *
 * Picks village centers with minimum spacing, then expands each into
 * a cluster of neighboring eligible cells. Produces a Set<cubeKey>
 * consumed by Decorations.populateBuildings().
 */

import { cubeKey, CUBE_DIRS, cubeDistance, parseCubeKey } from './HexWFCCore.js'
// Threshold is now a placer parameter (terrain shaping already modulates density)

export class VillagePlacer {
  /**
   * @param {Map<string,number>} villageDensity — per-cell density from TerrainNoise
   * @param {Set<string>} forestCells — ForestPlacer output (cubeKeys to exclude)
   * @param {Object} [options]
   * @param {number} [options.threshold=0.35]         — density threshold (lower than raw noise threshold since terrain shaping already modulates)
   * @param {number} [options.minVillageDistance=4]   — minimum hex distance between village centers
   * @param {number} [options.clusterRadius=1]       — include neighbors within this radius
   */
  constructor(villageDensity, forestCells, options = {}) {
    this.villageDensity = villageDensity
    this.forestCells = forestCells || new Set()
    this.threshold = options.threshold ?? 0.35
    this.minVillageDistance = options.minVillageDistance ?? 4
    this.clusterRadius = options.clusterRadius ?? 1
  }

  /**
   * Identify village zone cells.
   * @returns {Set<string>} cubeKeys of cells suitable for village buildings
   */
  place() {
    const threshold = this.threshold

    // Collect candidates above threshold, excluding forest cells
    const candidates = []
    for (const [key, density] of this.villageDensity) {
      if (this.forestCells.has(key)) continue
      if (density >= threshold) {
        candidates.push({ key, density })
      }
    }

    // Sort by density descending — best sites get picked first
    candidates.sort((a, b) => b.density - a.density)

    const villageCells = new Set()
    const centers = [] // { q, r, s }

    for (const { key } of candidates) {
      const coords = parseCubeKey(key)

      // Enforce minimum distance from other village centers
      let tooClose = false
      for (const p of centers) {
        if (cubeDistance(coords.q, coords.r, coords.s, p.q, p.r, p.s) < this.minVillageDistance) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      // Add center
      villageCells.add(key)
      centers.push(coords)

      // Expand cluster: add eligible neighbors
      for (const dir of CUBE_DIRS) {
        const nk = cubeKey(coords.q + dir.dq, coords.r + dir.dr, coords.s + dir.ds)
        if (this.villageDensity.has(nk) && !this.forestCells.has(nk)) {
          villageCells.add(nk)
        }
      }
    }

    return villageCells
  }
}
