/**
 * PlateDebugOverlay — renders colored hex fills to visualise tectonic plates
 * and their boundaries before WFC solving.
 *
 * Each plate gets a distinct hue. Boundary cells are rendered with a brighter
 * shade and slight color shift to indicate convergent (warm) vs divergent (cool).
 * Ocean constraint cells get white hex outlines.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  LineSegments,
  LineBasicMaterial,
  MeshBasicNodeMaterial,
  DoubleSide,
} from 'three/webgpu'
import { attribute } from 'three/tsl'
import { cubeToOffset, parseCubeKey, cubeKey } from './HexWFCCore.js'

const HEX_WIDTH = 2
const HEX_HEIGHT = 2 / Math.sqrt(3) * 2
const HEX_RADIUS = 2 / Math.sqrt(3) * 0.85
const Y_OFFSET = 0.05

// Generate a visually distinct color for each plate index
function plateColor(index, count) {
  const hue = index / Math.max(count, 1)
  // HSL to RGB (saturation 0.6, lightness 0.45)
  return hslToRgb(hue, 0.6, 0.45)
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
  }
  return { r: f(0), g: f(8), b: f(4) }
}

export class PlateDebugOverlay {
  constructor(scene) {
    this.scene = scene
    this.mesh = null
    this.outlineMesh = null
  }

  /**
   * Build the overlay from tectonic plate data.
   * @param {Object} tectonicData — result of generateTectonicPlates()
   *   { plates: Map<cubeKey, plateIndex>, boundaries, oceanCells, debug: { plateSeeds, plateVectors } }
   */
  update(tectonicData) {
    this.dispose()
    if (!tectonicData || !tectonicData.plates) return

    const { plates, boundaries, oceanCells } = tectonicData

    // Build a set of boundary keys + scores for quick lookup
    const boundaryScoreMap = new Map()
    if (boundaries) {
      for (const bc of boundaries) {
        const key = `${bc.q},${bc.r},${bc.s}`
        boundaryScoreMap.set(key, bc.score)
      }
    }

    // Count distinct plates
    const plateIndices = new Set(plates.values())
    const plateCount = plateIndices.size

    const cellCount = plates.size
    const vertsPerCell = 6 * 3 // 6 triangles, 3 verts each
    const floatsPerCell = vertsPerCell * 3
    const positions = new Float32Array(cellCount * floatsPerCell)
    const colors = new Float32Array(cellCount * vertsPerCell * 4)

    // Two distinct boundary colors
    const convergentColor = { r: 1.0, g: 0.3, b: 0.1 }  // bright orange-red
    const divergentColor  = { r: 0.1, g: 0.8, b: 0.2 }  // bright green

    let cellIdx = 0
    for (const [key, plateIndex] of plates) {
      const { q, r, s } = parseCubeKey(key)
      const offset = cubeToOffset(q, r, s)
      const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
      const cz = offset.row * HEX_HEIGHT * 0.75
      const cy = 1 + Y_OFFSET

      const isBoundary = boundaryScoreMap.has(key)
      let color, alpha
      if (isBoundary) {
        const score = boundaryScoreMap.get(key)
        color = score > 0 ? convergentColor : divergentColor
        alpha = 0.75
      } else {
        color = plateColor(plateIndex, plateCount)
        alpha = 0.35
      }

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
          colors[cOff + v * 4 + 3] = alpha
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

    this.mesh = new Mesh(geom, mat)
    this.mesh.renderOrder = 995
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.scene.add(this.mesh)

    // ---- White outlines for ocean constraint cells ----
    if (oceanCells && oceanCells.length > 0) {
      // 6 line segments per hex, 2 endpoints × 3 floats = 36 floats per hex
      const linePositions = new Float32Array(oceanCells.length * 36)
      const cy2 = 1 + Y_OFFSET * 2  // slightly above fills
      let li = 0
      for (const oc of oceanCells) {
        const offset = cubeToOffset(oc.q, oc.r, oc.s)
        const cx = offset.col * HEX_WIDTH + (Math.abs(offset.row) % 2) * HEX_WIDTH * 0.5
        const cz = offset.row * HEX_HEIGHT * 0.75

        for (let i = 0; i < 6; i++) {
          const a1 = i * Math.PI / 3
          const a2 = ((i + 1) % 6) * Math.PI / 3
          linePositions[li++] = cx + Math.sin(a1) * HEX_RADIUS
          linePositions[li++] = cy2
          linePositions[li++] = cz + Math.cos(a1) * HEX_RADIUS
          linePositions[li++] = cx + Math.sin(a2) * HEX_RADIUS
          linePositions[li++] = cy2
          linePositions[li++] = cz + Math.cos(a2) * HEX_RADIUS
        }
      }

      const lineGeom = new BufferGeometry()
      lineGeom.setAttribute('position', new Float32BufferAttribute(linePositions, 3))
      const lineMat = new LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false })

      this.outlineMesh = new LineSegments(lineGeom, lineMat)
      this.outlineMesh.renderOrder = 996
      this.outlineMesh.frustumCulled = false
      this.outlineMesh.visible = false
      this.scene.add(this.outlineMesh)
    }
  }

  setVisible(visible) {
    if (this.mesh) this.mesh.visible = visible
    if (this.outlineMesh) this.outlineMesh.visible = visible
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
      this.mesh = null
    }
    if (this.outlineMesh) {
      this.scene.remove(this.outlineMesh)
      this.outlineMesh.geometry.dispose()
      this.outlineMesh.material.dispose()
      this.outlineMesh = null
    }
  }
}
