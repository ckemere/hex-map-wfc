/**
 * TerrainNoise — terrain-shaped density fields for post-WFC placement
 *
 * After WFC terrain and river routing are complete, builds density maps
 * that combine the base simplex noise with terrain features. The noise
 * IS the terrain — elevation, river proximity, and coast distance are
 * baked into the density values rather than applied as post-hoc biases.
 *
 * Produces per-cell density values [0,1] that ForestPlacer and
 * VillagePlacer threshold directly.
 */

import { cubeKey, cubeToOffset, parseCubeKey, CUBE_DIRS, cubeDistance } from './HexWFCCore.js'
import { TILE_LIST, TileType } from './HexTileData.js'
import { HexTileGeometry } from './HexTiles.js'
import { globalNoiseA, globalNoiseB, globalNoiseC } from './DecorationDefs.js'

/**
 * Compute the minimum hex distance from a cell to any cell in a set.
 * Returns Infinity if the set is empty.
 */
function minDistToSet(q, r, s, positions) {
  let min = Infinity
  for (const p of positions) {
    const d = cubeDistance(q, r, s, p.q, p.r, p.s)
    if (d < min) min = d
    if (d <= 1) return d  // early exit — can't get closer
  }
  return min
}

/**
 * Build terrain-shaped density maps for forest and village placement.
 *
 * @param {Map} globalCells — HexMap.globalCells (cubeKey → cell)
 * @param {Map} riverCells  — RiverRouter.riverCells (cubeKey → info)
 * @param {Object} [options]
 * @param {number} [options.riverRange=4]     — max distance for river influence
 * @param {number} [options.coastRange=2]     — max distance for coast suppression
 * @param {number} [options.forestIdealLevel=1] — elevation forests prefer
 * @param {number} [options.villageMaxLevel=1]  — elevation ceiling for villages
 * @returns {{ forestDensity: Map<string,number>, villageDensity: Map<string,number> }}
 */
export function buildTerrainDensity(globalCells, riverCells, options = {}) {
  const riverRange = options.riverRange ?? 4
  const coastRange = options.coastRange ?? 2
  const forestIdealLevel = options.forestIdealLevel ?? 1
  const villageMaxLevel = options.villageMaxLevel ?? 1

  if (!globalNoiseA || !globalNoiseB || !globalNoiseC) {
    console.warn('[TerrainNoise] Global noise not initialized')
    return { forestDensity: new Map(), villageDensity: new Map() }
  }

  // Pre-collect positions for distance lookups
  const riverPositions = []
  for (const key of riverCells.keys()) {
    riverPositions.push(parseCubeKey(key))
  }

  const coastPositions = []
  for (const [key, cell] of globalCells) {
    const def = TILE_LIST[cell.type]
    if (def && (def.name.startsWith('COAST_') || def.name === 'WATER')) {
      coastPositions.push({ q: cell.q, r: cell.r, s: cell.s })
    }
  }

  const forestDensity = new Map()
  const villageDensity = new Map()

  for (const [key, cell] of globalCells) {
    // Only grass tiles are candidates for either
    if (cell.type !== TileType.GRASS) continue
    if (riverCells.has(key)) continue

    // Convert to world position for noise sampling
    const offset = cubeToOffset(cell.q, cell.r, cell.s)
    const worldPos = HexTileGeometry.getWorldPosition(offset.col, offset.row)

    // --- Terrain features (shared) ---
    const distToRiver = minDistToSet(cell.q, cell.r, cell.s, riverPositions)
    const distToCoast = minDistToSet(cell.q, cell.r, cell.s, coastPositions)

    // Coast suppression: [0,1] where 0 = on coast, 1 = far from coast
    const coastFade = distToCoast <= coastRange
      ? distToCoast / coastRange
      : 1

    // River attraction: [0,1] where 1 = adjacent to river, 0 = far away
    const riverAttraction = distToRiver <= riverRange
      ? 1 - distToRiver / (riverRange + 1)
      : 0

    // --- Forest density ---
    // Base: max of the two tree noise fields (same as Decorations)
    const noiseA = globalNoiseA.scaled2D(worldPos.x, worldPos.z)
    const noiseB = globalNoiseB.scaled2D(worldPos.x, worldPos.z)
    const baseForestNoise = Math.max(noiseA, noiseB)

    // Elevation shaping: forests prefer mid-elevation, fade at extremes
    const levelDist = Math.abs(cell.level - forestIdealLevel)
    const elevationForest = Math.max(0, 1 - levelDist * 0.25)

    // Combine: noise × terrain modifiers
    const fDensity = baseForestNoise * elevationForest * coastFade
      * (1 + riverAttraction * 0.3)  // mild river boost

    forestDensity.set(key, Math.min(1, fDensity))

    // --- Village density ---
    const baseVillageNoise = globalNoiseC.scaled2D(worldPos.x, worldPos.z)

    // Elevation shaping: villages strongly prefer flat, low terrain
    const elevationVillage = cell.level <= villageMaxLevel
      ? 1
      : Math.max(0, 1 - (cell.level - villageMaxLevel) * 0.4)

    // Combine: noise × terrain modifiers
    // Rivers have a stronger pull for villages than forests
    const vDensity = baseVillageNoise * elevationVillage * coastFade
      * (1 + riverAttraction * 0.6)  // strong river boost

    villageDensity.set(key, Math.min(1, vDensity))
  }

  return { forestDensity, villageDensity }
}
