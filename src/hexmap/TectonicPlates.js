/**
 * TectonicPlates — pre-WFC plate tectonics simulation
 *
 * Generates tectonic plates across the hex world, assigns movement vectors,
 * classifies plate boundaries (convergent/divergent/transform), and produces
 * a per-cell elevation bias that guides WFC toward realistic mountain ranges.
 *
 * Pipeline:
 *   1. Voronoi-style flood fill assigns cells to plates
 *   2. Each plate gets a random movement vector
 *   3. Adjacent cells on different plates → boundary classification
 *   4. Boundary influence diffuses inward → per-cell elevation target
 *   5. Elevation bias fed to WFC solver as per-cell level weights
 */

import { cubeKey, parseCubeKey, CUBE_DIRS, cubeDistance } from './HexWFCCore.js'
import { random, shuffle } from '../SeededRandom.js'
import { LEVELS_COUNT } from './HexTileData.js'

/**
 * Generate tectonic plates and compute per-cell elevation bias.
 *
 * @param {Array<{q,r,s}>} allCells — every cell in the world (cube coords)
 * @param {Object} [options]
 * @param {number} [options.plateCount=6]        — number of tectonic plates
 * @param {number} [options.influenceRadius=12]   — how far boundary effects diffuse (hex cells)
 * @param {number} [options.convergentLevel=4]    — target level at convergent boundaries
 * @param {number} [options.divergentLevel=0]     — target level at divergent boundaries
 * @param {number} [options.neutralLevel=1]       — default interior level
 * @param {number} [options.biasStrength=2.0]     — how strongly bias affects WFC weights
 * @returns {{ elevationBias: Object, plates: Map, boundaries: Array, debug: Object }}
 *   - elevationBias: { [cubeKey]: targetLevel } for every cell
 *   - plates: Map<cubeKey, plateIndex>
 *   - boundaries: Array of boundary info for visualization
 *   - debug: { plateSeeds, plateVectors }
 */
export function generateTectonicPlates(allCells, options = {}) {
  const plateCount = options.plateCount ?? 6
  const influenceRadius = options.influenceRadius ?? 12
  const convergentLevel = options.convergentLevel ?? (LEVELS_COUNT - 1) // 4
  const divergentLevel = options.divergentLevel ?? -1
  const neutralLevel = options.neutralLevel ?? 1
  const biasStrength = options.biasStrength ?? 2.0
  const divergentWidth = options.divergentWidth ?? 4

  // Build adjacency lookup from allCells
  const cellSet = new Set(allCells.map(c => cubeKey(c.q, c.r, c.s)))

  // --- Phase 1: Assign cells to plates via concurrent BFS ---
  const { plateMap, plateSeeds } = assignPlates(allCells, cellSet, plateCount)

  // --- Phase 2: Assign random movement vectors to each plate ---
  const plateVectors = generatePlateVectors(plateCount)

  // --- Phase 3: Classify boundaries ---
  const { boundaryScores, boundaryCells } = classifyBoundaries(
    allCells, cellSet, plateMap, plateVectors, plateSeeds
  )

  // --- Phase 3b: Widen divergent boundaries ---
  expandDivergentBoundaries(cellSet, boundaryScores, boundaryCells, divergentWidth)

  // --- Phase 4: Diffuse boundary influence into elevation bias ---
  const elevationBias = computeElevationBias(
    allCells, cellSet, boundaryCells, boundaryScores,
    influenceRadius, convergentLevel, divergentLevel, neutralLevel
  )

  // --- Phase 5: Collect cells to pre-place as ocean ---
  // Any cell whose elevation bias is below 0 should be hard-set as OCEAN
  // before WFC solving, rather than relying on weight biasing.
  const oceanCells = []
  for (const cell of allCells) {
    const key = cubeKey(cell.q, cell.r, cell.s)
    if ((elevationBias[key] ?? neutralLevel) < 0) {
      oceanCells.push({ q: cell.q, r: cell.r, s: cell.s })
    }
  }

  return {
    elevationBias,
    biasStrength,
    plates: plateMap,
    boundaries: boundaryCells,
    oceanCells,
    debug: { plateSeeds, plateVectors },
  }
}

/**
 * Assign each cell to a plate using simultaneous BFS from random seeds.
 * Cells are claimed by whichever plate's wavefront reaches them first,
 * producing organic Voronoi-like regions on the hex grid.
 */
function assignPlates(allCells, cellSet, plateCount) {
  const plateMap = new Map() // cubeKey → plateIndex

  // Pick N random seed cells
  const indices = allCells.map((_, i) => i)
  shuffle(indices)
  const plateSeeds = []
  for (let i = 0; i < Math.min(plateCount, allCells.length); i++) {
    const cell = allCells[indices[i]]
    const key = cubeKey(cell.q, cell.r, cell.s)
    plateSeeds.push({ q: cell.q, r: cell.r, s: cell.s, plateIndex: i })
    plateMap.set(key, i)
  }

  // Concurrent BFS — all plates expand one ring at a time
  let frontier = plateSeeds.map(s => ({ q: s.q, r: s.r, s: s.s, plate: s.plateIndex }))

  while (frontier.length > 0) {
    // Shuffle frontier so no plate systematically gets priority
    shuffle(frontier)
    const nextFrontier = []

    for (const { q, r, s, plate } of frontier) {
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.dq
        const nr = r + dir.dr
        const ns = s + dir.ds
        const nKey = cubeKey(nq, nr, ns)

        if (!cellSet.has(nKey)) continue
        if (plateMap.has(nKey)) continue

        plateMap.set(nKey, plate)
        nextFrontier.push({ q: nq, r: nr, s: ns, plate })
      }
    }

    frontier = nextFrontier
  }

  return { plateMap, plateSeeds }
}

/**
 * Generate random 2D movement vectors for each plate.
 * Direction is a random angle, magnitude varies to create some fast/slow plates.
 */
function generatePlateVectors(plateCount) {
  const vectors = []
  for (let i = 0; i < plateCount; i++) {
    const angle = random() * Math.PI * 2
    const magnitude = 0.3 + random() * 0.7 // [0.3, 1.0]
    vectors.push({
      dx: Math.cos(angle) * magnitude,
      dz: Math.sin(angle) * magnitude,
    })
  }
  return vectors
}

/**
 * Classify each boundary between adjacent cells on different plates.
 *
 * For each boundary cell pair, compute how convergent or divergent
 * the plates are:
 *   score > 0  → convergent (plates colliding → mountains)
 *   score < 0  → divergent  (plates separating → ocean/rift)
 *   score ≈ 0  → transform  (sliding past → neutral)
 *
 * The score is the dot product of the relative plate motion with the
 * boundary normal (pointing from plate A toward plate B).
 */
function classifyBoundaries(allCells, cellSet, plateMap, plateVectors, plateSeeds) {
  // Compute plate centroids for boundary normal calculation
  const plateSums = new Map() // plateIndex → { sx, sr, count }
  for (const cell of allCells) {
    const key = cubeKey(cell.q, cell.r, cell.s)
    const plate = plateMap.get(key)
    if (plate === undefined) continue
    if (!plateSums.has(plate)) plateSums.set(plate, { sq: 0, sr: 0, count: 0 })
    const s = plateSums.get(plate)
    s.sq += cell.q
    s.sr += cell.r
    s.count++
  }

  const plateCentroids = new Map()
  for (const [plate, s] of plateSums) {
    plateCentroids.set(plate, { q: s.sq / s.count, r: s.sr / s.count })
  }

  // For each cell, check neighbors on different plates
  const boundaryScores = new Map() // cubeKey → convergence score [-1, 1]
  const boundaryCells = [] // { q, r, s, score, plateA, plateB }
  const visited = new Set()

  for (const cell of allCells) {
    const key = cubeKey(cell.q, cell.r, cell.s)
    const plateA = plateMap.get(key)
    if (plateA === undefined) continue

    for (const dir of CUBE_DIRS) {
      const nq = cell.q + dir.dq
      const nr = cell.r + dir.dr
      const ns = cell.s + dir.ds
      const nKey = cubeKey(nq, nr, ns)

      if (!cellSet.has(nKey)) continue
      const plateB = plateMap.get(nKey)
      if (plateB === undefined || plateB === plateA) continue

      // This cell is on a plate boundary
      const pairKey = `${Math.min(plateA, plateB)}_${Math.max(plateA, plateB)}_${key}`
      if (visited.has(pairKey)) continue
      visited.add(pairKey)

      // Boundary normal: direction from cell toward neighbor (in cube space)
      const normalQ = dir.dq
      const normalR = dir.dr

      // Relative motion: plateA's velocity minus plateB's velocity
      const vecA = plateVectors[plateA]
      const vecB = plateVectors[plateB]
      const relDx = vecA.dx - vecB.dx
      const relDz = vecA.dz - vecB.dz

      // Convert cube normal to approximate 2D direction
      // Pointy-top hex: q axis is ~(1, 0), r axis is ~(-0.5, 0.866)
      const nx = normalQ + normalR * -0.5
      const nz = normalR * 0.866

      // Dot product: positive = convergent (moving toward each other)
      const dot = -(relDx * nx + relDz * nz)
      // Normalize to [-1, 1]
      const len = Math.sqrt(nx * nx + nz * nz) * Math.sqrt(relDx * relDx + relDz * relDz)
      const score = len > 0.001 ? dot / len : 0

      // Accumulate (a cell might border multiple plates)
      const existing = boundaryScores.get(key)
      if (existing === undefined || Math.abs(score) > Math.abs(existing)) {
        boundaryScores.set(key, score)
      }

      if (!visited.has(`boundary_${key}`)) {
        visited.add(`boundary_${key}`)
        boundaryCells.push({ q: cell.q, r: cell.r, s: cell.s, score, plateA, plateB })
      }
    }
  }

  return { boundaryScores, boundaryCells }
}

/**
 * Expand divergent boundary cells outward by BFS to create wider ocean rifts.
 * New cells get the nearest divergent boundary's score, attenuated by distance.
 * Mutates boundaryScores and boundaryCells in place.
 */
function expandDivergentBoundaries(cellSet, boundaryScores, boundaryCells, width) {
  if (width <= 1) return

  // Collect divergent seed cells (score < 0)
  let frontier = []
  for (const bc of boundaryCells) {
    if (bc.score < 0) {
      frontier.push({ q: bc.q, r: bc.r, s: bc.s, score: bc.score, dist: 0 })
    }
  }

  for (let ring = 1; ring < width; ring++) {
    const nextFrontier = []
    for (const { q, r, s, score } of frontier) {
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.dq
        const nr = r + dir.dr
        const ns = s + dir.ds
        const nKey = cubeKey(nq, nr, ns)

        if (!cellSet.has(nKey)) continue
        if (boundaryScores.has(nKey)) continue

        // Full divergent score across the entire zone — the influence-radius
        // diffusion (Phase 4) handles the smooth transition to neutral beyond.
        boundaryScores.set(nKey, score)
        boundaryCells.push({ q: nq, r: nr, s: ns, score, plateA: -1, plateB: -1 })
        nextFrontier.push({ q: nq, r: nr, s: ns, score, dist: ring })
      }
    }
    frontier = nextFrontier
  }
}

/**
 * Diffuse boundary influence to compute a smooth per-cell target elevation.
 *
 * Each boundary cell has a convergence score. We spread this influence
 * outward with distance falloff to create broad mountain ranges
 * (near convergent boundaries) and ocean basins (near divergent ones).
 *
 * Interior cells far from any boundary get the neutral level.
 */
function computeElevationBias(
  allCells, cellSet, boundaryCells, boundaryScores,
  influenceRadius, convergentLevel, divergentLevel, neutralLevel
) {
  const elevationBias = {}

  // Pre-collect boundary positions for distance lookup
  const boundaryList = []
  for (const bc of boundaryCells) {
    const key = cubeKey(bc.q, bc.r, bc.s)
    const score = boundaryScores.get(key) ?? 0
    boundaryList.push({ q: bc.q, r: bc.r, s: bc.s, score })
  }

  for (const cell of allCells) {
    const key = cubeKey(cell.q, cell.r, cell.s)

    // Check if this cell is itself a boundary
    const selfScore = boundaryScores.get(key)
    if (selfScore !== undefined) {
      elevationBias[key] = scoreToLevel(selfScore, convergentLevel, divergentLevel, neutralLevel)
      continue
    }

    // Find influence from nearby boundaries (weighted by distance)
    let weightedScore = 0
    let totalWeight = 0

    for (const bc of boundaryList) {
      const dist = cubeDistance(cell.q, cell.r, cell.s, bc.q, bc.r, bc.s)
      if (dist > influenceRadius) continue

      // Smooth falloff: (1 - dist/radius)^2 for quadratic decay
      const t = 1 - dist / influenceRadius
      const weight = t * t
      weightedScore += bc.score * weight
      totalWeight += weight
    }

    if (totalWeight > 0) {
      const avgScore = weightedScore / totalWeight
      elevationBias[key] = scoreToLevel(avgScore, convergentLevel, divergentLevel, neutralLevel)
    } else {
      // Far from any boundary → neutral
      elevationBias[key] = neutralLevel
    }
  }

  return elevationBias
}

/**
 * Map a convergence score [-1, 1] to a target elevation level.
 *   score > 0  → interpolate neutralLevel → convergentLevel
 *   score < 0  → interpolate neutralLevel → divergentLevel
 *   score = 0  → neutralLevel
 */
function scoreToLevel(score, convergentLevel, divergentLevel, neutralLevel) {
  if (score > 0) {
    return neutralLevel + (convergentLevel - neutralLevel) * score
  } else {
    return neutralLevel + (neutralLevel - divergentLevel) * score
  }
}
