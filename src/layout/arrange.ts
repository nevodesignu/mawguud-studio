// The layout brain behind "Perfect it" and the Sign Bot.
//
// PHILOSOPHY: read the designer's intent, then make it crisp. The user's
// sizes are kept (heights only shrink when something doesn't fit - never
// grow). The divider stays where the user put it (snapped to exact center
// only when it is already close). What gets perfected: exact centering in
// each region, even stack spacing, equalizing lines that were clearly meant
// to be the same size, and clamping overflow. Deterministic and idempotent.
import type { Design, TextEl, DividerEl } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / ink height
}

const GAP_FACTOR = 0.45 // line gap as a fraction of the mean line height
const SNAP_CENTER = 0.05 // divider within 5% of center means "I meant center"
const EQUALIZE = 1.15 // heights within 15% of each other were meant to match

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
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

interface Group {
  lines: Measured[]
  boxL: number
  boxT: number
  boxR: number
  boxB: number
}

/**
 * Perfect all groups while respecting intent:
 * - shared shrink factor s <= 1: sizes are the user's, we only shrink to fit
 * - lines whose heights are within EQUALIZE of each other snap to one height
 *   (small accidental differences were clearly meant to be equal)
 * - every stack is centered in its region with even gaps
 */
function planGroups(groups: Group[], patches: Record<string, ElPatch>): void {
  const active = groups.filter((g) => g.lines.length > 0)
  if (active.length === 0) return

  let s = 1
  for (const g of active) {
    const cw = g.boxR - g.boxL
    const budget = g.boxB - g.boxT
    const hs = g.lines.map((m) => Math.max(1, m.el.heightMm))
    const sumH = hs.reduce((a, b) => a + b, 0)
    const meanH = sumH / hs.length
    // the stack must fit its region height...
    s = Math.min(s, budget / (sumH + GAP_FACTOR * meanH * (g.lines.length - 1)))
    // ...and every line must fit its region width
    g.lines.forEach((m, i) => {
      s = Math.min(s, cw / m.aspect / hs[i])
    })
  }

  // heights after the fit-shrink
  const all = active.flatMap((g) => g.lines)
  const height = new Map<string, number>(all.map((m) => [m.el.id, Math.max(1, m.el.heightMm) * s]))

  // equalize clusters: sort by height, walk, snap near-equal lines to the
  // cluster minimum (minimum keeps every fit guarantee intact)
  const sorted = [...all].sort((a, b) => height.get(a.el.id)! - height.get(b.el.id)!)
  let clusterStart = 0
  for (let i = 1; i <= sorted.length; i++) {
    const startH = height.get(sorted[clusterStart].el.id)!
    if (i === sorted.length || height.get(sorted[i].el.id)! > startH * EQUALIZE) {
      for (let j = clusterStart; j < i; j++) height.set(sorted[j].el.id, startH)
      clusterStart = i
    }
  }

  for (const g of active) {
    const heights = g.lines.map((m) => height.get(m.el.id)!)
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
    // Left | Right - the divider stays where the user put it (their own
    // templates use off-center dividers when one side holds the longer name)
    const divX = Math.abs(div.x - w / 2) < SNAP_CENTER * w ? w / 2 : clamp(div.x, 0.2 * w, 0.8 * w)
    const divY = Math.abs(div.y - h / 2) < SNAP_CENTER * h ? h / 2 : clamp(div.y, 0.2 * h, 0.8 * h)
    patches[div.id] = { x: r1(divX), y: r1(divY), vertical: true, length: r1(Math.min(div.length, 0.9 * h)) }
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
    // Up | Down (wide) and Vertical (tall): divider height is the user's call,
    // snapped to exact middle only when they clearly meant the middle
    const divY = Math.abs(div.y - h / 2) < SNAP_CENTER * h ? h / 2 : clamp(div.y, 0.15 * h, 0.85 * h)
    const divX = Math.abs(div.x - w / 2) < SNAP_CENTER * w ? w / 2 : clamp(div.x, 0.2 * w, 0.8 * w)
    patches[div.id] = { x: r1(divX), y: r1(divY), vertical: false, length: r1(Math.min(div.length, 0.92 * w)) }
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
