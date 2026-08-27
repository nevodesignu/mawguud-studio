// The layout brain: takes a design and computes perfect positions/sizes for
// every element based on the board size and the sign's structure. Used by the
// "Perfect it" button and by the Sign Bot. Deterministic - same input, same
// perfect output, every time.
import type { Design, TextEl, DividerEl } from '../model'
import { isNumberLine } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / ink height
}

const GAP_FACTOR = 0.45 // line gap as a fraction of the mean line height

async function measure(el: TextEl): Promise<Measured> {
  try {
    const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
    const w = shaped.bbox.maxX - shaped.bbox.minX
    const h = shaped.bbox.maxY - shaped.bbox.minY
    return { el, aspect: h > 0 && w > 0 ? w / h : 4 }
  } catch {
    return { el, aspect: 4 }
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10

interface Group {
  lines: Measured[]
  boxL: number
  boxT: number
  boxR: number
  boxB: number
}

/**
 * Lay all groups of text lines with ONE shared scale, so relative sizes are
 * preserved across the whole sign - a column with two short words must not
 * balloon bigger than the name column next to it. Per line, clamp to the
 * column width and to half its region (the proportions of the real templates).
 * Each stack is centered inside its box.
 */
function planGroups(groups: Group[], patches: Record<string, ElPatch>): void {
  const active = groups.filter((g) => g.lines.length > 0)
  if (active.length === 0) return
  // canonical ratios, matching the real production templates: number lines
  // read ~1.6x bigger than name lines, and every name line on the sign shares
  // ONE height (the most constrained line sets it) - so a short word can never
  // balloon bigger than the name next to it. Deterministic: "perfect" always
  // means the same thing no matter how the design currently looks.
  const ratioOf = (m: Measured) => (isNumberLine(m.el.text) ? 1.6 : 1.0)
  let s = Infinity
  for (const g of active) {
    const cw = g.boxR - g.boxL
    const budget = g.boxB - g.boxT
    const ratios = g.lines.map(ratioOf)
    const sumR = ratios.reduce((a, b) => a + b, 0)
    const meanR = sumR / ratios.length
    // the stack must fit its height budget...
    s = Math.min(s, budget / (sumR + GAP_FACTOR * meanR * (g.lines.length - 1)))
    // ...and every line must fit its column width and stay under half its region
    g.lines.forEach((m, i) => {
      s = Math.min(s, Math.min(0.5 * budget, cw / m.aspect) / ratios[i])
    })
  }
  for (const g of active) {
    const heights = g.lines.map((m) => ratioOf(m) * s)
    const meanH = heights.reduce((a, b) => a + b, 0) / heights.length
    const gap = GAP_FACTOR * meanH
    const total = heights.reduce((a, b) => a + b, 0) + gap * (g.lines.length - 1)
    let y = (g.boxT + g.boxB) / 2 - total / 2
    const cx = (g.boxL + g.boxR) / 2
    g.lines.forEach((m, i) => {
      patches[m.el.id] = { x: r1(cx), y: r1(y + heights[i] / 2), heightMm: r1(heights[i]) }
      y += heights[i] + gap
    })
  }
}

/** Compute perfect-layout patches for every element (keyed by element id). */
export async function arrangeDesign(design: Design): Promise<Record<string, ElPatch>> {
  const { w, h } = design.sign
  const patches: Record<string, ElPatch> = {}
  const texts = design.elements.filter((e): e is TextEl => e.kind === 'text' && e.text.trim().length > 0)
  const dividers = design.elements.filter((e): e is DividerEl => e.kind === 'divider')
  const measured = await Promise.all(texts.map(measure))
  const byY = (a: Measured, b: Measured) => a.el.y - b.el.y

  const padX = Math.max(0.08 * w, 12)
  const padY = Math.max(0.08 * h, 12)
  const div = dividers[0]

  if (div && div.vertical) {
    // Left | Right
    const divX = w / 2
    patches[div.id] = { x: r1(divX), y: r1(h / 2), vertical: true, length: r1(0.64 * h) }
    for (const extra of dividers.slice(1)) patches[extra.id] = { x: r1(divX), y: r1(h / 2) }
    const gap = 0.045 * w
    const left = measured.filter((m) => m.el.x < divX).sort(byY)
    const right = measured.filter((m) => m.el.x >= divX).sort(byY)
    planGroups(
      [
        { lines: right, boxL: divX + gap, boxT: padY, boxR: w - padX, boxB: h - padY },
        { lines: left, boxL: padX, boxT: padY, boxR: divX - gap, boxB: h - padY },
      ],
      patches,
    )
  } else if (div) {
    // Up | Down (wide boards) and Vertical (tall boards) share the structure
    const tall = h > w
    const divY = tall ? 0.32 * h : h / 2
    patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1((tall ? 0.64 : 0.66) * w) }
    const gap = 0.05 * h
    const top = measured.filter((m) => m.el.y < divY).sort(byY)
    const bottom = measured.filter((m) => m.el.y >= divY).sort(byY)
    planGroups(
      [
        { lines: top, boxL: padX, boxT: padY, boxR: w - padX, boxB: divY - gap },
        { lines: bottom, boxL: padX, boxT: divY + gap, boxR: w - padX, boxB: h - padY },
      ],
      patches,
    )
  } else {
    // no divider: one centered stack
    planGroups([{ lines: measured.sort(byY), boxL: padX, boxT: padY, boxR: w - padX, boxB: h - padY }], patches)
  }
  return patches
}
