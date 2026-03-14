/**
 * RiverDebugOverlay — renders colored hex fills on the terrain to visualise
 * routed river paths before tile replacement.
 *
 * Colours:
 *   source       → red        (#ff3333)
 *   path         → blue       (#3388ff)
 *   confluence   → magenta    (#ff33ff)
 *   coast_end    → cyan       (#33ffcc)
 *   edge_end     → yellow     (#ffcc33)
 *   basin_end    → orange     (#ff8833)
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  DoubleSide,
} from 'three/webgpu'
import { attribute, vec4 } from 'three/tsl'
import { cubeToOffset } from './HexWFCCore.js'
import { RiverCellType } from './RiverRouter.js'

const COLORS = {
  [RiverCellType.SOURCE]:     { r: 1.0, g: 0.2, b: 0.2 },
  [RiverCellType.PATH]:       { r: 0.2, g: 0.53, b: 1.0 },
  [RiverCellType.CONFLUENCE]: { r: 1.0, g: 0.2, b: 1.0 },
  [RiverCellType.COAST_END]:  { r: 0.2, g: 1.0, b: 0.8 },
  [RiverCellType.EDGE_END]:   { r: 1.0, g: 0.8, b: 0.2 },
  [RiverCellType.BASIN_END]:  { r: 1.0, g: 0.53, b: 0.2 },
}

const HEX_WIDTH = 2
const HEX_HEIGHT = 2 / Math.sqrt(3) * 2
const HEX_RADIUS = 2 / Math.sqrt(3) * 0.85 // slightly smaller than cell
const LEVEL_HEIGHT = 0.5
const Y_OFFSET = 0.05 // float slightly above tile surface

export class RiverDebugOverlay {
  constructor(scene) {
    this.scene = scene
    this.mesh = null
  }

  /**
   * Build (or rebuild) the overlay mesh from river cell data.
   * Renders directly in the main scene (not in the PostFX overlay pass).
   * @param {Map<string, { type: string, riverIndex: number }>} riverCells
   * @param {Map<string, Object>} globalCells — HexMap.globalCells for elevation lookup
   */
  update(riverCells, globalCells) {
    this.dispose()

    if (!riverCells || riverCells.size === 0) return

    const cellCount = riverCells.size
    // 6 triangles per hex (fan from center)
    const vertsPerCell = 6 * 3
    const floatsPerCell = vertsPerCell * 3
    const positions = new Float32Array(cellCount * floatsPerCell)
    const colors = new Float32Array(cellCount * vertsPerCell * 4) // RGBA per vertex

    let cellIdx = 0
    for (const [key, info] of riverCells) {
      const parts = key.split(',').map(Number)
      const q = parts[0], r = parts[1], s = parts[2]

      // World position from global cube coords → offset → pixel coords
      const offset = cubeToOffset(q, r, s)
      const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
      const cz = offset.row * HEX_HEIGHT * 0.75

      // Y from cell elevation
      const gc = globalCells.get(key)
      const level = gc ? gc.level : 0
      const cy = level * LEVEL_HEIGHT + 1 + Y_OFFSET // 1 = TILE_SURFACE

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

    // Use TSL node to read vertex color attribute directly
    const mat = new MeshBasicNodeMaterial()
    const vertColor = attribute('color', 'vec4')
    mat.colorNode = vertColor.rgb
    mat.opacityNode = vertColor.a
    mat.transparent = true
    mat.depthWrite = false
    mat.side = DoubleSide

    this.mesh = new Mesh(geom, mat)
    this.mesh.renderOrder = 997
    this.mesh.frustumCulled = false
    this.mesh.visible = false // hidden until debug view selects it
    this.scene.add(this.mesh)
  }

  /** Set visibility of the overlay */
  setVisible(visible) {
    if (this.mesh) this.mesh.visible = visible
  }

  /** Remove mesh from scene and free GPU resources */
  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
      this.mesh = null
    }
  }
}
