/**
 * Shared utilities for river and road routing.
 */

// ---------------------------------------------------------------------------
// Min-heap priority queue (binary heap, smallest cost first)
// ---------------------------------------------------------------------------

export class MinHeap {
  constructor() { this._data = [] }

  get size() { return this._data.length }

  push(item) {
    this._data.push(item)
    this._bubbleUp(this._data.length - 1)
  }

  pop() {
    const top = this._data[0]
    const last = this._data.pop()
    if (this._data.length > 0) {
      this._data[0] = last
      this._sinkDown(0)
    }
    return top
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this._data[i].cost < this._data[parent].cost) {
        [this._data[i], this._data[parent]] = [this._data[parent], this._data[i]]
        i = parent
      } else break
    }
  }

  _sinkDown(i) {
    const n = this._data.length
    while (true) {
      let smallest = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this._data[l].cost < this._data[smallest].cost) smallest = l
      if (r < n && this._data[r].cost < this._data[smallest].cost) smallest = r
      if (smallest === i) break
      ;[this._data[i], this._data[smallest]] = [this._data[smallest], this._data[i]]
      i = smallest
    }
  }
}

// ---------------------------------------------------------------------------
// Direction bitmask utilities
// ---------------------------------------------------------------------------

/** Convert a Set or iterable of direction indices (0–5) to a 6-bit mask. */
export function dirSetToMask(dirs) {
  let mask = 0
  for (const d of dirs) mask |= (1 << d)
  return mask
}

/**
 * Build a 64-entry lookup table mapping 6-bit direction bitmasks to
 * { type, rotation } for a set of tile templates.
 *
 * @param {Array<{ type: number, dirs: number[] }>} templates
 * @returns {Array<{ type: number, rotation: number } | null>}
 */
export function buildTileLookup(templates) {
  const lookup = new Array(64).fill(null)
  for (const { type, dirs } of templates) {
    for (let r = 0; r < 6; r++) {
      const mask = dirs.reduce((m, d) => m | (1 << ((d + r) % 6)), 0)
      if (!lookup[mask]) {
        lookup[mask] = { type, rotation: r }
      }
    }
  }
  return lookup
}
