/**
 * RoadDebugOverlay — renders colored hex fills on the terrain to visualise
 * routed road paths before tile replacement.
 *
 * Colours (road cells):
 *   terminal     → orange      (#ff8833)
 *   path         → yellow      (#cccc33)
 *   junction     → magenta     (#ff33ff)
 *   road_end     → red         (#ff3333)
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  DoubleSide,
} from 'three/webgpu'
import { attribute } from 'three/tsl'
import { cubeToOffset } from './HexWFCCore.js'
import { RoadCellType } from './RoadRouter.js'

const COLORS = {
  [RoadCellType.TERMINAL]: { r: 1.0, g: 0.53, b: 0.2 },
  [RoadCellType.PATH]:     { r: 0.8, g: 0.8, b: 0.2 },
  [RoadCellType.JUNCTION]: { r: 1.0, g: 0.2, b: 1.0 },
  [RoadCellType.ROAD_END]: { r: 1.0, g: 0.2, b: 0.2 },
}

const HEX_WIDTH = 2
const HEX_HEIGHT = 2 / Math.sqrt(3) * 2
const HEX_RADIUS = 2 / Math.sqrt(3) * 0.85
const LEVEL_HEIGHT = 0.5
const Y_OFFSET = 0.06 // slightly above tile surface (above river overlay)

export class RoadDebugOverlay {
  constructor(scene) {
    this.scene = scene
    this.roadMesh = null
  }

  /**
   * Build (or rebuild) the overlay mesh from road cell data.
   * @param {Map<string, { type: string }>} roadCells
   * @param {Map<string, Object>} globalCells
   */
  update(roadCells, globalCells) {
    this.dispose()
    this._buildRoadOverlay(roadCells, globalCells)
  }

  _buildRoadOverlay(roadCells, globalCells) {
    if (!roadCells || roadCells.size === 0) return

    const cellCount = roadCells.size
    const vertsPerCell = 6 * 3
    const floatsPerCell = vertsPerCell * 3
    const positions = new Float32Array(cellCount * floatsPerCell)
    const colors = new Float32Array(cellCount * vertsPerCell * 4)

    let cellIdx = 0
    for (const [key, info] of roadCells) {
      const parts = key.split(',').map(Number)
      const q = parts[0], r = parts[1], s = parts[2]

      const offset = cubeToOffset(q, r, s)
      const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
      const cz = offset.row * HEX_HEIGHT * 0.75

      const gc = globalCells.get(key)
      const level = gc ? gc.level : 0
      const cy = level * LEVEL_HEIGHT + 1 + Y_OFFSET

      const color = COLORS[info.type] || COLORS[RoadCellType.PATH]
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
    mat.depthTest = false
    mat.side = DoubleSide

    this.roadMesh = new Mesh(geom, mat)
    this.roadMesh.renderOrder = 998
    this.roadMesh.frustumCulled = false
    this.roadMesh.visible = false
    this.scene.add(this.roadMesh)
  }

  setVisible(visible) {
    if (this.roadMesh) this.roadMesh.visible = visible
  }

  dispose() {
    if (this.roadMesh) {
      this.scene.remove(this.roadMesh)
      this.roadMesh.geometry.dispose()
      this.roadMesh.material.dispose()
      this.roadMesh = null
    }
  }
}
