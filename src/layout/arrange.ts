// The layout brain behind "Perfect it" and the Sign Bot - v4, trained on real
// Mawguud production cut files and the owner's corrections:
//
//   - lines have ROLES: a small label (Villa / apartment word) sits above a
//     BIG number (label ~0.85 units, number ~2.0, name lines 1.0)
//   - vertical spacing is computed on INK EXTENTS, not slot boxes: descenders
//     and hamzas can never collide, and gaps stay visually tight (0.18 of the
//     letter height)
//   - the divider is SHORT and content-matched (block extent x1.15)
//   - content fills ~78% of the width with generous margins
//   - letter|number signs ("B | 223") sit on ONE row at equal size
//   - Up|Down signs with a label + number on top ("Villa   34") spread them on
//     one row - label toward one edge, number toward the other - with the
//     divider spanning the full content width (the catalog product look)
//
// Sizes derive from text roles + board alone (deterministic); Perfect-it mode
// additionally treats user-set sizes as a grow-only floor.
import type { Design, TextEl, DividerEl } from '../model'
import { isNumberLine } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / reference height
  inkPerRef: number // ink height / reference height (>1 for hamza/descenders)
  role: 'name' | 'number' | 'label'
  unit?: number // explicit size override in ratio units (special modes)
}

const LABEL_RE =
  /^(شقة|شقه|فيلا|عمارة|عماره|دور|مكتب|محل|عيادة|عياده|رقم|بدروم|villa|apt\.?|apartment|flat|office|floor|shop|unit|no\.?|bezmnt|basement)$/i

const RATIO: Record<'name' | 'number' | 'label', number> = { name: 1.0, number: 2.0, label: 0.85 }
const STACK_GAP = 0.18 // ink gap between lines, fraction of mean letter height
const WIDTH_FILL = 0.78 // ensemble width target as fraction of board width
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
    const ih = shaped.bbox.maxY - shaped.bbox.minY
    const ref = shaped.refHeight > 0 ? shaped.refHeight : ih
    return { el, aspect: ref > 0 && w > 0 ? w / ref : 4, inkPerRef: ref > 0 && ih > 0 ? ih / ref : 1, role }
  } catch {
    return { el, aspect: 4, inkPerRef: 1, role }
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10
const f1 = (v: number) => Math.floor(v * 10) / 10
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const ratioOf = (m: Measured) => m.unit ?? RATIO[m.role]

/** Stack extent of a group in ratio units, using INK heights + ink gaps. */
function stackUnits(lines: Measured[]): number {
  if (lines.length === 0) return 0
  const rs = lines.map(ratioOf)
  const meanR = rs.reduce((a, b) => a + b, 0) / rs.length
  const ink = lines.reduce((a, m) => a + ratioOf(m) * m.inkPerRef, 0)
  return ink + STACK_GAP * meanR * (lines.length - 1)
}

/** Widest line of a group in ratio units. */
const blockUnits = (lines: Measured[]) => (lines.length ? Math.max(...lines.map((m) => m.aspect * ratioOf(m))) : 0)

/** Place one stack centered at (cx, cy) with scale s - spacing by ink extents. */
function placeStack(lines: Measured[], s: number, cx: number, cy: number, patches: Record<string, ElPatch>): void {
  if (lines.length === 0) return
  const slots = lines.map((m) => f1(ratioOf(m) * s))
  const meanSlot = slots.reduce((a, b) => a + b, 0) / slots.length
  const gap = STACK_GAP * meanSlot
  const inkHs = lines.map((m, i) => slots[i] * m.inkPerRef)
  const total = inkHs.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)
  let y = cy - total / 2
  lines.forEach((m, i) => {
    patches[m.el.id] = { x: r1(cx), y: r1(y + inkHs[i] / 2), heightMm: slots[i] }
    y += inkHs[i] + gap
  })
}

const stackHeightMm = (lines: Measured[], s: number) => {
  if (!lines.length) return 0
  const slots = lines.map((m) => f1(ratioOf(m) * s))
  const meanSlot = slots.reduce((a, b) => a + b, 0) / slots.length
  return lines.reduce((a, m, i) => a + slots[i] * m.inkPerRef, 0) + STACK_GAP * meanSlot * (lines.length - 1)
}

const blockWidthMm = (lines: Measured[], s: number) => (lines.length ? Math.max(...lines.map((m) => m.aspect * f1(ratioOf(m) * s))) : 0)

const hasArabic = (t: string) => /[؀-ۿ]/.test(t)

export interface ArrangeOpts {
  /**
   * Perfect-it mode: the user's current sizes are a FLOOR. The canonical scale
   * can match or grow them but never shrink below what the user set by hand -
   * except past the physical limits of the board.
   */
  respectSizes?: boolean
}

/** The user's expressed scale intent: the largest current height per ratio unit. */
const userScale = (groups: Measured[][]) => {
  const all = groups.flat()
  return all.length ? Math.max(...all.map((m) => Math.max(1, m.el.heightMm) / ratioOf(m))) : 0
}

/** Compute perfect-layout patches for every element (keyed by element id). */
export async function arrangeDesign(design: Design, opts: ArrangeOpts = {}): Promise<Record<string, ElPatch>> {
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
    const rows: Measured[][] = oneRow ? [right, left].map((g) => g.map((m) => ({ ...m, unit: 2.0 }))) : [right, left]
    const [R, L] = rows

    const gapX = DIV_GAP_X * w
    const unitsW = blockUnits(R) + blockUnits(L)
    const gapsW = (R.length ? gapX : 0) + (L.length ? gapX : 0) + div.thickness
    let s = unitsW > 0 ? (WIDTH_FILL * w - gapsW) / unitsW : 1
    for (const g of [R, L]) {
      if (!g.length) continue
      s = Math.min(s, (HEIGHT_FILL * h) / stackUnits(g))
      for (const m of g) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
    }
    if (opts.respectSizes) {
      // never shrink below what the user set - up to the physical board limits
      let sHard = unitsW > 0 ? (0.92 * w - gapsW) / unitsW : s
      for (const g of [R, L]) {
        if (!g.length) continue
        sHard = Math.min(sHard, (0.9 * h) / stackUnits(g))
        for (const m of g) sHard = Math.min(sHard, ((m.role === 'number' ? 0.38 : 0.5) * h) / ratioOf(m))
      }
      s = Math.max(s, Math.min(userScale([R, L]), sHard))
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

    // catalog top-row mode: a label + a number on top spread on ONE row
    // ("Villa   34"), equal size, divider spanning the full content width
    const topRowPair =
      top.length === 2 &&
      top.filter((m) => m.role === 'number').length === 1 &&
      top.every((m) => m.role === 'number' || m.role === 'label' || m.el.text.trim().length <= 8)

    if (topRowPair) {
      const rowUnit = 1.7
      const row = top.map((m) => ({ ...m, unit: rowUnit }))
      const num = row.find((m) => m.role === 'number')!
      const other = row.find((m) => m.role !== 'number')!
      // Arabic reads right-to-left: the label goes right, the number left
      const labelRight = hasArabic(other.el.text)
      const CW = WIDTH_FILL * w
      const midGap = 0.06 * w

      let s = Infinity
      const rowInk = rowUnit * Math.max(...row.map((m) => m.inkPerRef))
      const unitsH = rowInk + stackUnits(bottom)
      const gapsH = gapY + div.thickness + (bottom.length ? gapY : 0)
      s = Math.min(s, (HEIGHT_FILL * h - gapsH) / unitsH)
      s = Math.min(s, (CW - midGap) / (num.aspect * rowUnit + other.aspect * rowUnit))
      for (const m of bottom) s = Math.min(s, CW / (m.aspect * ratioOf(m)))
      s = Math.min(s, (NUMBER_CAP * h) / rowUnit)
      for (const m of bottom) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      if (opts.respectSizes) {
        const sHard = Math.min((0.9 * h - gapsH) / unitsH, (0.94 * w - midGap) / ((num.aspect + other.aspect) * rowUnit))
        s = Math.max(s, Math.min(userScale([row, bottom]), sHard))
      }

      const rowH = rowInk * s
      const hB = stackHeightMm(bottom, s)
      const total = rowH + gapY + div.thickness + (bottom.length ? gapY : 0) + hB
      const y0 = (h - total) / 2
      const cyRow = y0 + rowH / 2
      const divY = y0 + rowH + gapY + div.thickness / 2
      const cyB = divY + div.thickness / 2 + (bottom.length ? gapY : 0) + hB / 2

      const xL = (w - CW) / 2
      const xR = (w + CW) / 2
      const leftM = labelRight ? num : other
      const rightM = labelRight ? other : num
      const slotOf = (m: Measured) => f1(rowUnit * s)
      patches[leftM.el.id] = { x: r1(xL + (leftM.aspect * slotOf(leftM)) / 2), y: r1(cyRow), heightMm: slotOf(leftM) }
      patches[rightM.el.id] = { x: r1(xR - (rightM.aspect * slotOf(rightM)) / 2), y: r1(cyRow), heightMm: slotOf(rightM) }
      patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1(CW) }
      placeStack(bottom, s, w / 2, cyB, patches)
    } else {
      const unitsH = stackUnits(top) + stackUnits(bottom)
      const gapsH = (top.length ? gapY : 0) + (bottom.length ? gapY : 0) + div.thickness
      let s = unitsH > 0 ? (HEIGHT_FILL * h - gapsH) / unitsH : 1
      for (const m of measured) {
        s = Math.min(s, (0.8 * w) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      if (opts.respectSizes) {
        let sHard = unitsH > 0 ? (0.92 * h - gapsH) / unitsH : s
        for (const m of measured) {
          sHard = Math.min(sHard, (0.92 * w) / (m.aspect * ratioOf(m)))
          sHard = Math.min(sHard, ((m.role === 'number' ? 0.38 : 0.5) * h) / ratioOf(m))
        }
        s = Math.max(s, Math.min(userScale([top, bottom]), sHard))
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
    }
  } else {
    // ---- no divider: one centered stack ----
    const lines = [...measured].sort(byY)
    if (lines.length) {
      let s = (0.65 * h) / stackUnits(lines)
      for (const m of lines) {
        s = Math.min(s, (0.72 * w) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      if (opts.respectSizes) {
        let sHard = (0.9 * h) / stackUnits(lines)
        for (const m of lines) sHard = Math.min(sHard, (0.92 * w) / (m.aspect * ratioOf(m)))
        s = Math.max(s, Math.min(userScale([lines]), sHard))
      }
      placeStack(lines, s, w / 2, h / 2, patches)
    }
  }
  return patches
}
