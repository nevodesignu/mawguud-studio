// Shared math for drawing a shaped TextEl on screen and in exports.
import type { El, TextEl } from '../model'
import type { ShapedText } from '../shaping/engine'
import { shapedSync } from '../shaping/service'
import { cmdsToD } from '../geom/path'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Design-space bounding box of an element (uses the shaping cache for text). */
export function bboxOf(el: El): Box {
  if (el.kind === 'divider') {
    const w = el.vertical ? el.thickness : el.length
    const h = el.vertical ? el.length : el.thickness
    return { x: el.x - w / 2, y: el.y - h / 2, w, h }
  }
  const shaped = shapedSync(el.fontId, el.text, el.spacingEm)
  if (shaped) {
    const r = renderTextEl(el, shaped)
    if (r) return r.bboxMm
  }
  return { x: el.x - 25, y: el.y - 6, w: 50, h: 12 }
}

export interface TextRender {
  d: string // path in font units (y-up), all glyph offsets baked in
  transform: string // svg transform into design mm space
  s: number // mm per font unit
  ox: number
  oy: number
  bboxMm: { x: number; y: number; w: number; h: number } // ink bbox, design space (y-down)
}

export function renderTextEl(el: TextEl, shaped: ShapedText): TextRender | null {
  const { bbox } = shaped
  const inkH = bbox.maxY - bbox.minY
  const inkW = bbox.maxX - bbox.minX
  if (!(inkH > 0) || !(inkW >= 0)) return null
  // heightMm means "height of a standard tall letter" - normalizing by the
  // font's reference height keeps every line's letters the same visual size
  const s = el.heightMm / (shaped.refHeight > 0 ? shaped.refHeight : inkH)
  const cx = (bbox.minX + bbox.maxX) / 2
  const cy = (bbox.minY + bbox.maxY) / 2
  const ox = el.x - cx * s
  const oy = el.y + cy * s
  const d = shaped.glyphs.map((g) => cmdsToD(g.cmds, g.x, g.y)).join('')
  return {
    d,
    transform: `translate(${ox} ${oy}) scale(${s} ${-s})`,
    s,
    ox,
    oy,
    bboxMm: { x: ox + bbox.minX * s, y: oy - bbox.maxY * s, w: inkW * s, h: inkH * s },
  }
}
