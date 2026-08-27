// Shared math for drawing a shaped TextEl on screen and in exports.
import type { TextEl } from '../model'
import type { ShapedText } from '../shaping/engine'
import { cmdsToD } from '../geom/path'

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
