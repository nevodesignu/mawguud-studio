// The layout brain behind "Perfect it" and the Sign Bot.
//
// PHILOSOPHY: the user's intent is WHAT goes WHERE (which side of the divider,
// line order, deliberate size differences). The engine's job is the COMPOSITION:
// the ensemble of text blocks + divider is assembled with even breathing room
// and centered on the board - horizontally AND vertically - like a hand-built
// production file. Sizes only shrink to fit, never grow; heights within 15% of
// each other equalize (accidental drift was clearly meant to be equal).
// Deterministic and idempotent.
import type { Design, TextEl, DividerEl } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / ink height
}

const GAP_FACTOR = 0.45 // line gap inside a stack, fraction of mean line height
const EQUALIZE = 1.15 // heights within 15% were meant to match

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

/** Stack metrics for a set of lines at scale factor 1 (linear in s). */
function stackHeight(heights: number[]): number {
  if (heights.length === 0) return 0
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length
  return heights.reduce((a, b) => a + b, 0) + GAP_FACTOR * mean * (heights.length - 1)
}

/**
 * Equalize near-equal heights across the whole design (snap clusters to their
 * minimum), then round to the 0.1mm grid BEFORE any width/position math - so a
 * second "Perfect it" computes from exactly the stored values and changes nothing.
 */
function equalized(all: Measured[], scaled: Map<string, number>): Map<string, number> {
  const sorted = [...all].sort((a, b) => scaled.get(a.el.id)! - scaled.get(b.el.id)!)
  let start = 0
  for (let i = 1; i <= sorted.length; i++) {
    const startH = scaled.get(sorted[start].el.id)!
    if (i === sorted.length || scaled.get(sorted[i].el.id)! > startH * EQUALIZE) {
      for (let j = start; j < i; j++) scaled.set(sorted[j].el.id, startH)
      start = i
    }
  }
  // floor to the 0.1mm grid: rounding UP could nudge a width back over its
  // limit and make the next run shrink again (flip-flop instead of idempotent)
  for (const [id, v] of scaled) scaled.set(id, Math.floor(v * 10) / 10)
  return scaled
}

/** A shrink gets 0.2% headroom so re-running sees the layout as already fitting. */
const settle = (s: number) => (s < 1 ? s * 0.998 : 1)

/** Place one stack of lines centered at (cx, cy). */
function placeStack(lines: Measured[], heights: Map<string, number>, cx: number, cy: number, patches: Record<string, ElPatch>): void {
  if (lines.length === 0) return
  const hs = lines.map((m) => heights.get(m.el.id)!)
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  const gap = GAP_FACTOR * mean
  const total = hs.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)
  let y = cy - total / 2
  lines.forEach((m, i) => {
    patches[m.el.id] = { x: r1(cx), y: r1(y + hs[i] / 2), heightMm: r1(hs[i]) }
    y += hs[i] + gap
  })
}

const blockWidth = (lines: Measured[], heights: Map<string, number>) =>
  lines.length ? Math.max(...lines.map((m) => m.aspect * heights.get(m.el.id)!)) : 0

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
  const base = new Map<string, number>(measured.map((m) => [m.el.id, Math.max(1, m.el.heightMm)]))

  if (div && div.vertical) {
    // ---- Left | Right ----
    // Ensemble: [left block] gap [divider] gap [right block], centered on the
    // board. The divider lands between the blocks - wider names push it off
    // geometric center exactly like Mawguud's hand-made files.
    const right = measured.filter((m) => m.el.x >= div.x).sort(byY)
    const left = measured.filter((m) => m.el.x < div.x).sort(byY)
    const g = 0.055 * w
    const availW = w - 2 * padX
    const availH = h - 2 * padY

    let s = 1
    for (const lines of [right, left]) {
      if (!lines.length) continue
      s = Math.min(s, availH / stackHeight(lines.map((m) => base.get(m.el.id)!)))
    }
    const widthAt1 = blockWidth(right, base) + blockWidth(left, base)
    const gapsW = (right.length ? g : 0) + (left.length ? g : 0) + div.thickness
    if (widthAt1 > 0) s = Math.min(s, (availW - gapsW) / widthAt1)

    const heights = equalized(measured, new Map([...base].map(([id, v]) => [id, v * settle(s)])))
    const wR = blockWidth(right, heights)
    const wL = blockWidth(left, heights)
    const total = wL + (left.length ? g : 0) + div.thickness + (right.length ? g : 0) + wR
    const x0 = (w - total) / 2
    const cxL = x0 + wL / 2
    const divX = x0 + wL + (left.length ? g : 0) + div.thickness / 2
    const cxR = x0 + wL + (left.length ? g : 0) + div.thickness + (right.length ? g : 0) + wR / 2

    patches[div.id] = { x: r1(divX), y: r1(h / 2), vertical: true, length: r1(0.64 * h) }
    placeStack(right, heights, cxR, h / 2, patches)
    placeStack(left, heights, cxL, h / 2, patches)
  } else if (div) {
    // ---- Up | Down (wide) and Vertical (tall) ----
    // Same principle, vertically: [top block] gap [divider] gap [bottom block]
    // centered on the board; everything on the horizontal centerline.
    const top = measured.filter((m) => m.el.y < div.y).sort(byY)
    const bottom = measured.filter((m) => m.el.y >= div.y).sort(byY)
    const g = 0.06 * h
    const availW = w - 2 * padX
    const availH = h - 2 * padY

    let s = 1
    const heightAt1 = stackHeight(top.map((m) => base.get(m.el.id)!)) + stackHeight(bottom.map((m) => base.get(m.el.id)!))
    const gapsH = (top.length ? g : 0) + (bottom.length ? g : 0) + div.thickness
    if (heightAt1 > 0) s = Math.min(s, (availH - gapsH) / heightAt1)
    for (const m of measured) s = Math.min(s, availW / m.aspect / base.get(m.el.id)!)

    const heights = equalized(measured, new Map([...base].map(([id, v]) => [id, v * settle(s)])))
    const hT = stackHeight(top.map((m) => heights.get(m.el.id)!))
    const hB = stackHeight(bottom.map((m) => heights.get(m.el.id)!))
    const total = hT + (top.length ? g : 0) + div.thickness + (bottom.length ? g : 0) + hB
    const y0 = (h - total) / 2
    const cyT = y0 + hT / 2
    const divY = y0 + hT + (top.length ? g : 0) + div.thickness / 2
    const cyB = y0 + hT + (top.length ? g : 0) + div.thickness + (bottom.length ? g : 0) + hB / 2

    patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1((h > w ? 0.64 : 0.66) * w) }
    placeStack(top, heights, w / 2, cyT, patches)
    placeStack(bottom, heights, w / 2, cyB, patches)
  } else {
    // ---- no divider: one centered stack ----
    const lines = [...measured].sort(byY)
    const availW = w - 2 * padX
    const availH = h - 2 * padY
    let s = 1
    const hAt1 = stackHeight(lines.map((m) => base.get(m.el.id)!))
    if (hAt1 > 0) s = Math.min(s, availH / hAt1)
    for (const m of lines) s = Math.min(s, availW / m.aspect / base.get(m.el.id)!)
    const heights = equalized(measured, new Map([...base].map(([id, v]) => [id, v * settle(s)])))
    placeStack(lines, heights, w / 2, h / 2, patches)
  }
  return patches
}
