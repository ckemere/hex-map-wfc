/**
 * ForestPlacer — post-WFC forest zone identification (Step 4)
 *
 * Thresholds the terrain-shaped forest density field produced by
 * TerrainNoise.buildTerrainDensity(). All terrain awareness (elevation,
 * river proximity, coast avoidance) is baked into the density values.
 *
 * Produces a Set<cubeKey> consumed by Decorations.populate().
 */

import { getCurrentTreeThreshold } from './DecorationDefs.js'

export class ForestPlacer {
  /**
   * @param {Map<string,number>} forestDensity — per-cell density from TerrainNoise
   * @param {Object} [options]
   * @param {number} [options.threshold] — density threshold; defaults to tree noise threshold
   */
  constructor(forestDensity, options = {}) {
    this.forestDensity = forestDensity
    this.threshold = options.threshold ?? null  // null = use global tree threshold
  }

  /**
   * Identify forest zone cells.
   * @returns {Set<string>} cubeKeys of cells that should have forests
   */
  place() {
    const threshold = this.threshold ?? getCurrentTreeThreshold()
    const forestCells = new Set()

    for (const [key, density] of this.forestDensity) {
      if (density >= threshold) {
        forestCells.add(key)
      }
    }

    return forestCells
  }
}
