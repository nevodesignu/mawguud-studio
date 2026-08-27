// The layout brain behind "Perfect it" and the Sign Bot - v3, trained on real
// Mawguud production cut files. The rules extracted from those files:
//
//   - lines have ROLES: a small label (Villa / apartment word) sits above a BIG number
//     (label ~0.85 units, number ~2.0, name lines 1.0)
//   - the divider is SHORT and content-matched: it spans the text block beside
//     it (x1.15), never a fixed fraction of the board
//   - gaps are tight (stack gap 0.3 x line height, ~4.5% of width around the
//     divider), outer margins generous (content fills ~68% of the width)
//   - letter|number signs ("B | 223") sit on ONE row at equal size
//
// Sizes derive ONLY from text roles + board size - fully deterministic, so the
// bot designs the whole sign alone and re-running changes nothing.
import type { Design, TextEl, DividerEl } from '../model'
import { isNumberLine } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / ink height
  role: 'name' | 'number' | 'label'
}

const LABEL_RE =
  /^(شقة|شقه|فيلا|عمارة|عماره|دور|مكتب|محل|عيادة|عياده|رقم|بدروم|villa|apt\.?|apartment|flat|office|floor|shop|unit|no\.?|bezmnt|basement)$/i

const RATIO: Record<Measured['role'], number> = { name: 1.0, number: 2.0, label: 0.85 }
const STACK_GAP = 0.3 // fraction of mean line height
const WIDTH_FILL = 0.72 // ensemble width target as fraction of board width
const HEIGHT_FILL = 0.74 // ensemble height cap
const DIV_GAP_X = 0.045 // gap between divider and each block, fraction of W
const DIV_GAP_Y = 0.05 // for horizontal dividers, fraction of H
const LINE_CAP = 0.4 // no single line taller than this fraction of board H
const NUMBER_CAP = 0.3 // numbers in the production files run 24-35% of board H

async function measure(el: TextEl): Promise<Measured> {
  const role: Measured['role'] = isNumberLine(el.text) ? 'number' : LABEL_RE.test(el.text.trim()) ? 'label' : 'name'
  try {
    const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
    const w = shaped.bbox.maxX - shaped.bbox.minX
    const ref = shaped.refHeight > 0 ? shaped.refHeight : shaped.bbox.maxY - shaped.bbox.minY
    return { el, aspect: ref > 0 && w > 0 ? w / ref : 4, role }
  } catch {
    return { el, aspect: 4, role }
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10
const f1 = (v: number) => Math.floor(v * 10) / 10
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const ratioOf = (m: Measured) => RATIO[m.role]

/** Stack height of a group in ratio units. */
function stackUnits(lines: Measured[]): number {
  if (lines.length === 0) return 0
  const rs = lines.map(ratioOf)
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  return rs.reduce((a, b) => a + b, 0) + STACK_GAP * mean * (lines.length - 1)
}

/** Widest line of a group in ratio units. */
const blockUnits = (lines: Measured[]) => (lines.length ? Math.max(...lines.map((m) => m.aspect * ratioOf(m))) : 0)

/** Place one stack centered at (cx, cy) with scale s (mm per ratio unit). */
function placeStack(lines: Measured[], s: number, cx: number, cy: number, patches: Record<string, ElPatch>): void {
  if (lines.length === 0) return
  const hs = lines.map((m) => f1(ratioOf(m) * s))
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  const gap = STACK_GAP * mean
  const total = hs.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)
  let y = cy - total / 2
  lines.forEach((m, i) => {
    patches[m.el.id] = { x: r1(cx), y: r1(y + hs[i] / 2), heightMm: hs[i] }
    y += hs[i] + gap
  })
}

const stackHeightMm = (lines: Measured[], s: number) => {
  if (!lines.length) return 0
  const hs = lines.map((m) => f1(ratioOf(m) * s))
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  return hs.reduce((a, b) => a + b, 0) + STACK_GAP * mean * (lines.length - 1)
}

const blockWidthMm = (lines: Measured[], s: number) => (lines.length ? Math.max(...lines.map((m) => m.aspect * f1(ratioOf(m) * s))) : 0)

/** Compute perfect-layout patches for every element (keyed by element id). */
export async function arrangeDesign(design: Design): Promise<Record<string, ElPatch>> {
  const { w, h } = design.sign
  const patches: Record<string, ElPatch> = {}
  const texts = design.elements.filter((e): e is TextEl => e.kind === 'text' && e.text.trim().length > 0)
  const dividers = design.elements.filter((e): e is DividerEl => e.kind === 'divider')
  const measured = await Promise.all(texts.map(measure))
  const byY = (a: Measured, b: Measured) => a.el.y - b.el.y
  const div = dividers[0]

  if (div && div.vertical) {
    // ---- Left | Right ----
    const right = measured.filter((m) => m.el.x >= div.x).sort(byY)
    const left = measured.filter((m) => m.el.x < div.x).sort(byY)

    // letter|number mode: two short single lines sit on one row at equal size
    const shortSingle = (g: Measured[]) => g.length === 1 && g[0].el.text.trim().length <= 4
    const oneRow = shortSingle(right) && shortSingle(left)
    const rows: Measured[][] = oneRow ? [right, left].map((g) => g.map((m) => ({ ...m, role: 'number' as const }))) : [right, left]
    const [R, L] = rows

    const gapX = DIV_GAP_X * w
    // scale from the width target...
    const unitsW = blockUnits(R) + blockUnits(L)
    const gapsW = (R.length ? gapX : 0) + (L.length ? gapX : 0) + div.thickness
    let s = unitsW > 0 ? (WIDTH_FILL * w - gapsW) / unitsW : 1
    // ...capped by the height budget and the per-line cap
    for (const g of [R, L]) {
      if (!g.length) continue
      s = Math.min(s, (HEIGHT_FILL * h) / stackUnits(g))
      for (const m of g) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
    }

    const wR = blockWidthMm(R, s)
    const wL = blockWidthMm(L, s)
    const total = wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR
    const x0 = (w - total) / 2
    const cxL = x0 + wL / 2
    const divX = x0 + wL + (L.length ? gapX : 0) + div.thickness / 2
    const cxR = x0 + wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR / 2

    // divider spans the taller block, with a little overshoot - like the cut files
    const divLen = clamp(Math.max(stackHeightMm(R, s), stackHeightMm(L, s)) * 1.15, 0.22 * h, 0.8 * h)
    patches[div.id] = { x: r1(divX), y: r1(h / 2), vertical: true, length: r1(divLen) }
    placeStack(R, s, cxR, h / 2, patches)
    placeStack(L, s, cxL, h / 2, patches)
  } else if (div) {
    // ---- Up | Down (wide) and Vertical (tall) ----
    const top = measured.filter((m) => m.el.y < div.y).sort(byY)
    const bottom = measured.filter((m) => m.el.y >= div.y).sort(byY)
    const gapY = DIV_GAP_Y * h

    const unitsH = stackUnits(top) + stackUnits(bottom)
    const gapsH = (top.length ? gapY : 0) + (bottom.length ? gapY : 0) + div.thickness
    let s = unitsH > 0 ? (HEIGHT_FILL * h - gapsH) / unitsH : 1
    for (const m of measured) {
      s = Math.min(s, (0.8 * w) / (m.aspect * ratioOf(m)))
      s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
    }

    const hT = stackHeightMm(top, s)
    const hB = stackHeightMm(bottom, s)
    const total = hT + (top.length ? gapY : 0) + div.thickness + (bottom.length ? gapY : 0) + hB
    const y0 = (h - total) / 2
    const cyT = y0 + hT / 2
    const divY = y0 + hT + (top.length ? gapY : 0) + div.thickness / 2
    const cyB = y0 + hT + (top.length ? gapY : 0) + div.thickness + (bottom.length ? gapY : 0) + hB / 2

    // divider matches the wider block of content beside it
    const divLen = clamp(Math.max(blockWidthMm(top, s), blockWidthMm(bottom, s)) * 1.05, 0.3 * w, 0.85 * w)
    patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1(divLen) }
    placeStack(top, s, w / 2, cyT, patches)
    placeStack(bottom, s, w / 2, cyB, patches)
  } else {
    // ---- no divider: one centered stack ----
    const lines = [...measured].sort(byY)
    if (lines.length) {
      let s = (0.65 * h) / stackUnits(lines)
      for (const m of lines) {
        s = Math.min(s, (0.72 * w) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      placeStack(lines, s, w / 2, h / 2, patches)
    }
  }
  return patches
}
