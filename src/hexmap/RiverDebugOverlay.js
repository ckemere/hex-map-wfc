/**
 * RiverDebugOverlay — renders colored hex fills on the terrain to visualise
 * routed river paths before tile replacement.
 *
 * Colours (river cells):
 *   source       → red        (#ff3333)
 *   path         → blue       (#3388ff)
 *   confluence   → magenta    (#ff33ff)
 *   coast_end    → cyan       (#33ffcc)
 *   edge_end     → yellow     (#ffcc33)
 *   basin_end    → orange     (#ff8833)
 *
 * Slope tiles are shown as a background layer:
 *   low edges    → green tint
 *   high edges   → brown tint
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  DoubleSide,
} from 'three/webgpu'
import { attribute } from 'three/tsl'
import { cubeToOffset, getEdgeLevel, CUBE_DIRS } from './HexWFCCore.js'
import { TILE_LIST } from './HexTileData.js'
import { RiverCellType } from './RiverRouter.js'

const COLORS = {
  [RiverCellType.SOURCE]:     { r: 1.0, g: 0.2, b: 0.2 },
  [RiverCellType.PATH]:       { r: 0.2, g: 0.53, b: 1.0 },
  [RiverCellType.CONFLUENCE]: { r: 1.0, g: 0.2, b: 1.0 },
  [RiverCellType.COAST_END]:  { r: 0.2, g: 1.0, b: 0.8 },
  [RiverCellType.EDGE_END]:   { r: 1.0, g: 0.8, b: 0.2 },
  [RiverCellType.BASIN_END]:  { r: 1.0, g: 0.53, b: 0.2 },
}

// Slope edge colors
const SLOPE_LOW  = { r: 0.3, g: 0.7, b: 0.2 }  // green = low side
const SLOPE_HIGH = { r: 0.6, g: 0.3, b: 0.1 }  // brown = high side

const HEX_WIDTH = 2
const HEX_HEIGHT = 2 / Math.sqrt(3) * 2
const HEX_RADIUS = 2 / Math.sqrt(3) * 0.85 // slightly smaller than cell
const LEVEL_HEIGHT = 0.5
const Y_OFFSET = 0.05 // float slightly above tile surface

export class RiverDebugOverlay {
  constructor(scene) {
    this.scene = scene
    this.riverMesh = null
    this.slopeMesh = null
  }

  /**
   * Build (or rebuild) the overlay mesh from river cell data.
   * @param {Map<string, { type: string, riverIndex: number }>} riverCells
   * @param {Map<string, Object>} globalCells — HexMap.globalCells for elevation lookup
   */
  update(riverCells, globalCells) {
    this.dispose()

    this._buildSlopeOverlay(globalCells)
    this._buildRiverOverlay(riverCells, globalCells)
  }

  /**
   * Build overlay for slope tiles — each wedge colored by whether that edge
   * is the high or low side of the slope.
   */
  _buildSlopeOverlay(globalCells) {
    if (!globalCells || globalCells.size === 0) return

    // Collect slope cells
    const slopeCells = []
    for (const [key, cell] of globalCells) {
      const def = TILE_LIST[cell.type]
      if (!def?.highEdges?.length) continue
      slopeCells.push({ key, cell, def })
    }

    if (slopeCells.length === 0) return

    const vertsPerCell = 6 * 3
    const floatsPerCell = vertsPerCell * 3
    const positions = new Float32Array(slopeCells.length * floatsPerCell)
    const colors = new Float32Array(slopeCells.length * vertsPerCell * 4)

    for (let cellIdx = 0; cellIdx < slopeCells.length; cellIdx++) {
      const { key, cell } = slopeCells[cellIdx]
      const parts = key.split(',').map(Number)
      const q = parts[0], r = parts[1], s = parts[2]

      const offset = cubeToOffset(q, r, s)
      const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
      const cz = offset.row * HEX_HEIGHT * 0.75
      const cy = cell.level * LEVEL_HEIGHT + 1 + Y_OFFSET * 0.5

      const posBase = cellIdx * floatsPerCell
      const colBase = cellIdx * vertsPerCell * 4

      for (let i = 0; i < 6; i++) {
        const a1 = i * Math.PI / 3
        const a2 = ((i + 1) % 6) * Math.PI / 3
        const x1 = cx + Math.sin(a1) * HEX_RADIUS
        const z1 = cz + Math.cos(a1) * HEX_RADIUS
        const x2 = cx + Math.sin(a2) * HEX_RADIUS
        const z2 = cz + Math.cos(a2) * HEX_RADIUS

        const off = posBase + i * 9
        positions[off]     = cx;  positions[off + 1] = cy; positions[off + 2] = cz
        positions[off + 3] = x1; positions[off + 4] = cy; positions[off + 5] = z1
        positions[off + 6] = x2; positions[off + 7] = cy; positions[off + 8] = z2

        // Determine if this wedge's edge is high or low.
        // Wedge i corresponds to CUBE_DIRS[i] in our hex layout.
        const dirName = CUBE_DIRS[i].name
        const edgeLevel = getEdgeLevel(cell.type, cell.rotation, dirName, cell.level)
        const isHigh = edgeLevel > cell.level
        const color = isHigh ? SLOPE_HIGH : SLOPE_LOW

        const cOff = colBase + i * 12
        for (let v = 0; v < 3; v++) {
          colors[cOff + v * 4]     = color.r
          colors[cOff + v * 4 + 1] = color.g
          colors[cOff + v * 4 + 2] = color.b
          colors[cOff + v * 4 + 3] = 0.4
        }
      }
    }

    const geom = new BufferGeometry()
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geom.setAttribute('color', new Float32BufferAttribute(colors, 4))

    const mat = new MeshBasicNodeMaterial()
    const vertColor = attribute('color', 'vec4')
    mat.colorNode = vertColor.rgb
    mat.opacityNode = vertColor.a
    mat.transparent = true
    mat.depthWrite = false
    mat.side = DoubleSide

    this.slopeMesh = new Mesh(geom, mat)
    this.slopeMesh.renderOrder = 996
    this.slopeMesh.frustumCulled = false
    this.slopeMesh.visible = false
    this.scene.add(this.slopeMesh)
  }

  /**
   * Build overlay for river cells (sources, paths, endpoints).
   */
  _buildRiverOverlay(riverCells, globalCells) {
    if (!riverCells || riverCells.size === 0) return

    const cellCount = riverCells.size
    const vertsPerCell = 6 * 3
    const floatsPerCell = vertsPerCell * 3
    const positions = new Float32Array(cellCount * floatsPerCell)
    const colors = new Float32Array(cellCount * vertsPerCell * 4)

    let cellIdx = 0
    for (const [key, info] of riverCells) {
      const parts = key.split(',').map(Number)
      const q = parts[0], r = parts[1], s = parts[2]

      const offset = cubeToOffset(q, r, s)
      const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
      const cz = offset.row * HEX_HEIGHT * 0.75

      const gc = globalCells.get(key)
      const level = gc ? gc.level : 0
      const cy = level * LEVEL_HEIGHT + 1 + Y_OFFSET

      const color = COLORS[info.type] || COLORS[RiverCellType.PATH]
      const posBase = cellIdx * floatsPerCell
      const colBase = cellIdx * vertsPerCell * 4

      for (let i = 0; i < 6; i++) {
        const a1 = i * Math.PI / 3
        const a2 = ((i + 1) % 6) * Math.PI / 3
        const x1 = cx + Math.sin(a1) * HEX_RADIUS
        const z1 = cz + Math.cos(a1) * HEX_RADIUS
        const x2 = cx + Math.sin(a2) * HEX_RADIUS
        const z2 = cz + Math.cos(a2) * HEX_RADIUS

        const off = posBase + i * 9
        positions[off]     = cx;  positions[off + 1] = cy; positions[off + 2] = cz
        positions[off + 3] = x1; positions[off + 4] = cy; positions[off + 5] = z1
        positions[off + 6] = x2; positions[off + 7] = cy; positions[off + 8] = z2

        const cOff = colBase + i * 12
        for (let v = 0; v < 3; v++) {
          colors[cOff + v * 4]     = color.r
          colors[cOff + v * 4 + 1] = color.g
          colors[cOff + v * 4 + 2] = color.b
          colors[cOff + v * 4 + 3] = 0.55
        }
      }

      cellIdx++
    }

    const geom = new BufferGeometry()
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geom.setAttribute('color', new Float32BufferAttribute(colors, 4))

    const mat = new MeshBasicNodeMaterial()
    const vertColor = attribute('color', 'vec4')
    mat.colorNode = vertColor.rgb
    mat.opacityNode = vertColor.a
    mat.transparent = true
    mat.depthWrite = false
    mat.side = DoubleSide

    this.riverMesh = new Mesh(geom, mat)
    this.riverMesh.renderOrder = 997
    this.riverMesh.frustumCulled = false
    this.riverMesh.visible = false
    this.scene.add(this.riverMesh)
  }

  /** Set visibility of the overlay */
  setVisible(visible) {
    if (this.riverMesh) this.riverMesh.visible = visible
    if (this.slopeMesh) this.slopeMesh.visible = visible
  }

  /** Remove meshes from scene and free GPU resources */
  dispose() {
    if (this.riverMesh) {
      this.scene.remove(this.riverMesh)
      this.riverMesh.geometry.dispose()
      this.riverMesh.material.dispose()
      this.riverMesh = null
    }
    if (this.slopeMesh) {
      this.scene.remove(this.slopeMesh)
      this.slopeMesh.geometry.dispose()
      this.slopeMesh.material.dispose()
      this.slopeMesh = null
    }
  }
}
