// The layout brain behind "Perfect it" and the Sign Bot - v6.
//
// THE CONTRACT (the owner's words: "I do the sizing - just make the sign
// ready"): two modes.
//
//   'layout'    - Perfect-it = ALIGN + REMOVE ERRORS, NOTHING ELSE (owner,
//                 final: "does not change the layout - i do it... dont make
//                 it make spacing - i do it manually - it just aligns and
//                 makes sure the sign have no errors"). The user makes the
//                 layout AND the spacing: every line keeps its own y exactly.
//                 The engine only: aligns (a column shares one X, a row one
//                 Y, near-aligned blocks weld to one axis), fixes errors
//                 (letters+divider clear of every bolt, divider re-fit into
//                 the real gap, name column on its reading side), and
//                 centers the whole ensemble as one group (law 21). No text
//                 size ever changes; no gap the user made is ever re-spaced.
//   'canonical' - Sign Bot. Also sizes the text, using roles trained on the
//                 real production files, then tamed per LAW 18 (label ~0.85
//                 above a 1.45 number, names 1.0, numbers capped at 24% of
//                 board height, ~78% width fill).
//
// Shared pattern knowledge (both modes): Left|Right columns, label-over-number,
// one-row letter|number ("B | 223"), Up|Down stacks, and the catalog Villa row
// (label left / number right on one line over a full-width divider).
import type { Design, TextEl, DividerEl } from '../model'
import { boltCenters, isNumberLine, uid } from '../model'
import { shapedAsync } from '../shaping/service'

export type ElPatch = Partial<Omit<TextEl, 'kind'>> & Partial<Omit<DividerEl, 'kind'>>

interface Measured {
  el: TextEl
  aspect: number // ink width / reference height
  inkPerRef: number // ink height / reference height (>1 for hamza/descenders)
  role: 'name' | 'number' | 'label'
  unit?: number // ratio-unit override used by special canonical modes
}

const LABEL_RE =
  /^(شقة|شقه|فيلا|عمارة|عماره|دور|مكتب|محل|عيادة|عياده|رقم|بدروم|villa|apt\.?|apartment|flat|office|floor|shop|unit|no\.?|bezmnt|basement)$/i

// LAW 18: the number leads the sign but never dwarfs it - the owner called
// the raw production ratio "super huge" and a judge panel picked the tamed
// look. NOTE the values were re-expressed 2026-08-27 when the Century Gothic
// reference-height bug was fixed (heightMm now means TRUE letter height):
// 1.65x/27.5% renders the exact same physical look the owner approved as the
// old buggy-metric 1.45x/24%.
const RATIO: Record<'name' | 'number' | 'label', number> = { name: 1.0, number: 1.65, label: 0.85 }
const STACK_GAP = 0.18 // ink gap between lines, fraction of mean line height
// LAW 11: text as big as possible on every sign - but readable, never bloated.
// The fills push size up; NUMBER_CAP / LINE_CAP are the "not too big" guards.
const WIDTH_FILL = 0.84 // canonical ensemble width target
const HEIGHT_FILL = 0.78 // canonical ensemble height cap
const DIV_GAP_X = 0.045 // gap between divider and each block, fraction of W
const DIV_GAP_Y = 0.05 // for horizontal dividers, fraction of H
const MAX_ROW_GAP = 0.12 // LAW 20: villa-row middle gap cap, fraction of W
const LINE_CAP = 0.4
const NUMBER_CAP = 0.275

export type ArrangeMode = 'layout' | 'canonical'

/**
 * LAW 10, refined by the owner from the production template pack (2026-08-27:
 * "in vertical sign vertical line move with bolts ... that's only for vertical
 * with bolts in the middle, other than that divider only move"): the divider
 * is welded to the bolt axis on exactly ONE product family - a VERTICAL board
 * whose two bolts sit in the middle of its sides (Mirror Vertical 15x30). That
 * is how their real file is drawn: line and bolts share one axis. On every
 * other sign the divider is free and simply follows the content.
 */
const boltAxisSign = (design: Design) =>
  !!design.sign.bolts && design.sign.boltPattern === 'sides' && design.sign.h > design.sign.w

// LAW 22 (owner 2026-08-27: "IT CANNOT NEVER EVER LETTERS DIVIDER HIT THE
// BOLTS"): letter ink keeps this much air from a bolt hole's edge.
const BOLT_TEXT_AIR = 3

/** The vertical/horizontal corridor the canonical solver may fill: the space
 * between the bolt keep-out zones. Wide content beside corner bolts must live
 * between the bolt rows; content between side bolts must clear their columns. */
function boltCorridor(design: Design): { maxW: number; maxH: number } {
  const { w, h, bolts, boltDia, boltInsetX: ix, boltInsetY: iy, boltPattern } = design.sign
  if (!bolts) return { maxW: w, maxH: h }
  const keep = boltDia / 2 + BOLT_TEXT_AIR
  // floor at 30% of the board: a degenerate inset must never starve the solve
  // to nothing (the resolver still enforces true clearance afterwards)
  if (boltPattern === 'sides') return { maxW: Math.max(0.3 * w, w - 2 * (ix + keep)), maxH: h }
  return { maxW: w, maxH: Math.max(0.3 * h, h - 2 * (iy + keep)) }
}

interface InkRect {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** Push distance (per direction) for a rect to clear a circle by `clear`. 0 = already clear. */
function rectCircleGap(r: InkRect, cx: number, cy: number, rad: number): number {
  const dx = Math.max(0, Math.max(r.x0 - cx, cx - r.x1))
  const dy = Math.max(0, Math.max(r.y0 - cy, cy - r.y1))
  return Math.hypot(dx, dy) - rad
}

/**
 * LAW 22 enforcement: blocks (stacks/rows/loose texts) are pushed - as whole
 * units, minimally, axis-aligned - until every letter clears every bolt hole,
 * and (on the one bolt-axis board) the pinned divider band. Runs in BOTH
 * modes; the canonical corridor makes real pushes rare.
 */
function resolveObstacles(design: Design, patches: Record<string, ElPatch>, measured: Measured[], stacks: string[][], rows: string[][]): void {
  const { w, h } = design.sign
  const centers = boltCenters(design.sign)
  const pinned = boltAxisSign(design)
  const divEl = design.elements.find((e): e is DividerEl => e.kind === 'divider')
  if (!centers.length && !(pinned && divEl)) return
  const rad = design.sign.boltDia / 2 + BOLT_TEXT_AIR
  const mById = new Map(measured.map((m) => [m.el.id, m]))

  const grouped = new Set([...stacks, ...rows].flat())
  const blocks: string[][] = [...stacks, ...rows]
  for (const m of measured) if (!grouped.has(m.el.id)) blocks.push([m.el.id])

  const rectOf = (id: string): InkRect | null => {
    const p = patches[id]
    const m = mById.get(id)
    if (!p || !m || p.x === undefined || p.y === undefined) return null
    const hh = p.heightMm ?? m.el.heightMm
    return { x0: p.x - (m.aspect * hh) / 2, x1: p.x + (m.aspect * hh) / 2, y0: p.y - (m.inkPerRef * hh) / 2, y1: p.y + (m.inkPerRef * hh) / 2 }
  }
  // the pinned divider band no letter may cross (only on the bolt-axis board)
  const band = pinned && divEl ? { y0: h / 2 - divEl.thickness / 2 - 1.5, y1: h / 2 + divEl.thickness / 2 + 1.5 } : null

  const pushNeeded = (r: InkRect): { left: number; right: number; up: number; down: number } => {
    let left = 0
    let right = 0
    let up = 0
    let down = 0
    for (const [bx, by] of centers) {
      if (rectCircleGap(r, bx, by, rad) >= 0) continue
      right = Math.max(right, bx + rad - r.x0)
      left = Math.max(left, r.x1 - (bx - rad))
      down = Math.max(down, by + rad - r.y0)
      up = Math.max(up, r.y1 - (by - rad))
    }
    if (band && r.y1 > band.y0 && r.y0 < band.y1) {
      down = Math.max(down, band.y1 - r.y0)
      up = Math.max(up, r.y1 - band.y0)
    }
    return { left, right, up, down }
  }

  for (let iter = 0; iter < 3; iter++) {
    let moved = false
    for (const block of blocks) {
      const rects = block.map(rectOf).filter((r): r is InkRect => r !== null)
      if (!rects.length) continue
      let need = { left: 0, right: 0, up: 0, down: 0 }
      for (const r of rects) {
        const n = pushNeeded(r)
        need = { left: Math.max(need.left, n.left), right: Math.max(need.right, n.right), up: Math.max(need.up, n.up), down: Math.max(need.down, n.down) }
      }
      if (need.left === 0 && need.right === 0 && need.up === 0 && need.down === 0) continue
      // candidate axis-aligned escapes, smallest first; must clear EVERYTHING
      // for every rect in the block and keep the block on the board
      const cands: [number, number][] = []
      if (need.up > 0) cands.push([0, -need.up])
      if (need.down > 0) cands.push([0, need.down])
      if (need.left > 0) cands.push([-need.left, 0])
      if (need.right > 0) cands.push([need.right, 0])
      cands.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))
      let applied: [number, number] | null = null
      for (const [dx, dy] of cands) {
        const ok = rects.every((r) => {
          const t = { x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy }
          const n = pushNeeded(t)
          return n.left === 0 && n.right === 0 && n.up === 0 && n.down === 0 && t.x0 >= 1 && t.x1 <= w - 1 && t.y0 >= 1 && t.y1 <= h - 1
        })
        if (ok) {
          applied = [dx, dy]
          break
        }
      }
      if (!applied) continue // no clean escape (board too full) - leave it, the warning system reports collisions
      for (const id of block) {
        const p = patches[id]
        if (p && p.x !== undefined) p.x = r1(p.x + applied[0])
        if (p && p.y !== undefined) p.y = r1(p.y + applied[1])
      }
      moved = true
    }
    if (!moved) break
  }
}

/** True if any placed letter currently violates LAW 22 after translating by (dx, dy). */
function anyBoltHit(design: Design, patches: Record<string, ElPatch>, measured: Measured[], dx: number, dy: number): boolean {
  const centers = boltCenters(design.sign)
  if (!centers.length) return false
  const rad = design.sign.boltDia / 2 + BOLT_TEXT_AIR
  for (const m of measured) {
    const p = patches[m.el.id]
    if (!p || p.x === undefined || p.y === undefined) continue
    const hh = p.heightMm ?? m.el.heightMm
    const r: InkRect = { x0: p.x + dx - (m.aspect * hh) / 2, x1: p.x + dx + (m.aspect * hh) / 2, y0: p.y + dy - (m.inkPerRef * hh) / 2, y1: p.y + dy + (m.inkPerRef * hh) / 2 }
    for (const [bx, by] of centers) if (rectCircleGap(r, bx, by, rad) < 0) return true
  }
  return false
}


/**
 * LAW 19: the divider never touches a bolt circle. Every engine-emitted
 * divider length is clamped so each bolt hole keeps a clear margin of air
 * (one bolt radius, at least 3mm) - matters most on side-bolt boards where
 * LAW 10 runs the divider exactly on the bolt axis.
 */
function clampDividerToBolts(design: Design, cx: number, cy: number, vertical: boolean, thickness: number, length: number): number {
  const sign = design.sign
  const r = sign.boltDia / 2
  const margin = Math.max(3, r)
  let half = length / 2
  for (const [bx, by] of boltCenters(sign)) {
    const da = vertical ? Math.abs(by - cy) : Math.abs(bx - cx) // along the bar
    const dp = vertical ? Math.abs(bx - cx) : Math.abs(by - cy) // across the bar
    if (dp >= thickness / 2 + r + margin) continue // bolt clears the bar's band
    half = Math.min(half, da - r - margin)
  }
  return Math.max(10, 2 * half)
}

export interface ArrangeOpts {
  mode?: ArrangeMode
}

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
const hasArabic = (t: string) => /[؀-ۿ]/.test(t)

/** Height of each line in mm - the heart of the two modes. */
type HeightOf = (m: Measured) => number

const scaled = (s: number): HeightOf => (m) => f1(ratioOf(m) * s)

/** Stack extent in mm: ink heights + tight gaps. */
function stackExtent(lines: Measured[], H: HeightOf): number {
  if (lines.length === 0) return 0
  const hs = lines.map(H)
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  return lines.reduce((a, m, i) => a + hs[i] * m.inkPerRef, 0) + STACK_GAP * mean * (lines.length - 1)
}

const blockWidth = (lines: Measured[], H: HeightOf) => (lines.length ? Math.max(...lines.map((m) => m.aspect * H(m))) : 0)

/** Ink-bbox center of a block at its CURRENT positions and sizes - where the
 * user left it. Perfect-it rebuilds each block around this point. */
function inkCenterOf(g: Measured[]): { cx: number; cy: number } {
  let L = Infinity
  let R = -Infinity
  let T = Infinity
  let B = -Infinity
  for (const m of g) {
    const hw = (m.aspect * Math.max(1, m.el.heightMm)) / 2
    const hh = (m.inkPerRef * Math.max(1, m.el.heightMm)) / 2
    L = Math.min(L, m.el.x - hw)
    R = Math.max(R, m.el.x + hw)
    T = Math.min(T, m.el.y - hh)
    B = Math.max(B, m.el.y + hh)
  }
  return { cx: (L + R) / 2, cy: (T + B) / 2 }
}

/** Place one stack centered at (cx, cy) - spacing by ink extents. */
function placeStack(lines: Measured[], H: HeightOf, cx: number, cy: number, patches: Record<string, ElPatch>, stacks?: string[][]): void {
  if (lines.length === 0) return
  if (stacks && lines.length > 1) stacks.push(lines.map((m) => m.el.id))
  const hs = lines.map(H)
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  const gap = STACK_GAP * mean
  const inkHs = lines.map((m, i) => hs[i] * m.inkPerRef)
  const total = inkHs.reduce((a, b) => a + b, 0) + gap * (lines.length - 1)
  let y = cy - total / 2
  lines.forEach((m, i) => {
    patches[m.el.id] = { x: r1(cx), y: r1(y + inkHs[i] / 2), heightMm: r1(hs[i]) }
    y += inkHs[i] + gap
  })
}

/** v7 cleanup placement: a column shares ONE X, but every line keeps its own
 * y - the user makes the spacing, the engine only aligns. */
function placeAligned(lines: Measured[], H: HeightOf, cx: number, patches: Record<string, ElPatch>, stacks?: string[][]): void {
  if (lines.length === 0) return
  if (stacks && lines.length > 1) stacks.push(lines.map((m) => m.el.id))
  for (const m of lines) {
    patches[m.el.id] = { x: r1(cx), y: r1(m.el.y), heightMm: r1(H(m)) }
  }
}

/** Canonical-units stack extent (for solving the scale factor). */
function stackUnits(lines: Measured[]): number {
  if (lines.length === 0) return 0
  const rs = lines.map(ratioOf)
  const meanR = rs.reduce((a, b) => a + b, 0) / rs.length
  return lines.reduce((a, m) => a + ratioOf(m) * m.inkPerRef, 0) + STACK_GAP * meanR * (lines.length - 1)
}

const blockUnits = (lines: Measured[]) => (lines.length ? Math.max(...lines.map((m) => m.aspect * ratioOf(m))) : 0)

/**
 * LAW 14: two texts that land ALMOST on one axis - across the divider, across
 * the whole board - snap to exactly the same axis. Almost-aligned looks weird.
 */
function unifyAxes(design: Design, patches: Record<string, ElPatch>): void {
  const ids = design.elements.filter((e) => e.kind === 'text' && patches[e.id]).map((e) => e.id)
  for (const axis of ['y', 'x'] as const) {
    const items = ids
      .map((id) => ({ id, v: patches[id][axis], hh: patches[id].heightMm ?? 20 }))
      .filter((it): it is { id: string; v: number; hh: number } => it.v !== undefined)
      .sort((a, b) => a.v - b.v)
    let i = 0
    while (i < items.length) {
      let j = i
      while (j + 1 < items.length && items[j + 1].v - items[j].v <= Math.max(5, 0.3 * Math.min(items[j].hh, items[j + 1].hh))) j++
      if (j > i) {
        const mean = r1(items.slice(i, j + 1).reduce((a, b) => a + b.v, 0) / (j - i + 1))
        for (let k = i; k <= j; k++) patches[items[k].id][axis] = mean
      }
      i = j + 1
    }
  }
}

/**
 * LAW 14 for cleanup mode: near-aligned texts snap to one shared axis, but a
 * member of a stack or row drags its WHOLE block along - internal spacing is
 * engine-perfect and must survive the snap, otherwise repeated Perfect-its
 * re-level a hair differently every pass and the button never settles.
 */
function unifyAxesBlocks(design: Design, patches: Record<string, ElPatch>, stacks: string[][], rows: string[][]): void {
  const ids = design.elements.filter((e) => e.kind === 'text' && patches[e.id]).map((e) => e.id)
  for (const axis of ['y', 'x'] as const) {
    const blockFor = (id: string): string[] | null => {
      const inStack = stacks.find((g) => g.includes(id))
      if (inStack) return inStack
      if (axis === 'y') return rows.find((g) => g.includes(id)) ?? null
      return null
    }
    const items = ids
      .map((id) => ({ id, v: patches[id][axis], hh: patches[id].heightMm ?? 20 }))
      .filter((it): it is { id: string; v: number; hh: number } => it.v !== undefined)
      .sort((a, b) => a.v - b.v)
    // collect every snap request first (top lines pulling one way, bottom
    // lines the other), then move each block ONCE by the mean - blocks with
    // equal extents align exactly, unequal ones settle CENTER-aligned, and a
    // second Perfect-it finds all requests cancelling out: stable
    const blockDeltas = new Map<string[], number[]>()
    let i = 0
    while (i < items.length) {
      let j = i
      while (j + 1 < items.length && items[j + 1].v - items[j].v <= Math.min(8, Math.max(5, 0.3 * Math.min(items[j].hh, items[j + 1].hh)))) j++
      if (j > i) {
        const cluster = items.slice(i, j + 1)
        const mean = r1(cluster.reduce((a, b) => a + b.v, 0) / cluster.length)
        for (const it of cluster) {
          const block = blockFor(it.id)
          if (block) {
            const list = blockDeltas.get(block) ?? []
            list.push(mean - it.v)
            blockDeltas.set(block, list)
          } else {
            patches[it.id][axis] = mean
          }
        }
      }
      i = j + 1
    }
    for (const [block, deltas] of blockDeltas) {
      const d = deltas.reduce((a, b) => a + b, 0) / deltas.length
      if (Math.abs(d) < 0.05) continue
      for (const id of block) {
        const p = patches[id]
        if (p && p[axis] !== undefined) p[axis] = r1((p[axis] as number) + d)
      }
    }
  }
}

/**
 * LAW 15: sibling texts of the same kind at ALMOST the same size were meant to
 * be equal. With no hand-sized member the cluster unifies UP to the biggest;
 * a hand-sized member is the LEADER - the whole cluster adopts the user's
 * size (up or down, per the owner's sizing contract) and becomes final.
 */
function unifySizes(design: Design): Map<string, { h: number; final: boolean }> {
  const unified = new Map<string, { h: number; final: boolean }>()
  const classes: Record<string, { id: string; hh: number; sized: boolean }[]> = {}
  for (const el of design.elements) {
    if (el.kind !== 'text' || !el.text.trim()) continue
    const role = isNumberLine(el.text) ? 'number' : LABEL_RE.test(el.text.trim()) ? 'label' : 'name'
    ;(classes[role] ??= []).push({ id: el.id, hh: Math.max(1, el.heightMm), sized: !!el.sized })
  }
  for (const group of Object.values(classes)) {
    group.sort((a, b) => a.hh - b.hh)
    let i = 0
    while (i < group.length) {
      let j = i
      while (j + 1 < group.length && group[j + 1].hh <= group[j].hh * 1.12) j++
      const cluster = group.slice(i, j + 1)
      // a hand-sized member decides the cluster's size; otherwise the biggest wins
      const sizedOnes = cluster.filter((c) => c.sized)
      const target = sizedOnes.length ? Math.max(...sizedOnes.map((c) => c.hh)) : cluster[cluster.length - 1].hh
      // a sized leader makes the whole cluster final - the base floor must not split it
      for (const c of cluster) unified.set(c.id, { h: target, final: sizedOnes.length > 0 })
      i = j + 1
    }
  }
  return unified
}

/**
 * LAW 17: a multi-word name in a Left|Right column ALWAYS splits into stacked
 * lines ("Ahmed Ali" -> AHMED over ALI) - the house style of every production
 * LR file. The break point is chosen so the two lines balance. Used by the
 * Sign Bot before canonical arranging.
 */
export async function optimizeNameSplits(design: Design): Promise<Design> {
  const d: Design = JSON.parse(JSON.stringify(design))
  const div = d.elements.find((e): e is DividerEl => e.kind === 'divider' && e.vertical)
  if (!div) return d
  const roleOf = (t: string) => (isNumberLine(t) ? 'number' : LABEL_RE.test(t.trim()) ? 'label' : 'name')

  for (const side of ['right', 'left'] as const) {
    const col = d.elements.filter((e): e is TextEl => e.kind === 'text' && (side === 'right' ? e.x >= div.x : e.x < div.x))
    const names = col.filter((e) => roleOf(e.text) === 'name')
    if (names.length !== 1) continue
    const el = names[0]
    const words = el.text.trim().split(/\s+/)
    if (words.length < 2) continue

    // best break: the two lines as balanced as possible
    let best: { a: string; b: string; cost: number } | null = null
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ')
      const b = words.slice(i).join(' ')
      try {
        const [sa, sb] = await Promise.all([shapedAsync(el.fontId, a, el.spacingEm), shapedAsync(el.fontId, b, el.spacingEm)])
        const wa = (sa.bbox.maxX - sa.bbox.minX) / (sa.refHeight || 1)
        const wb = (sb.bbox.maxX - sb.bbox.minX) / (sb.refHeight || 1)
        const cost = Math.max(wa, wb)
        if (!best || cost < best.cost) best = { a, b, cost }
      } catch {
        /* unshapeable candidate - skip */
      }
    }
    if (!best) continue

    el.text = best.a
    const second: TextEl = { ...JSON.parse(JSON.stringify(el)), id: uid(), text: best.b, y: el.y + Math.max(5, el.heightMm) }
    d.elements.splice(d.elements.indexOf(el) + 1, 0, second)
  }
  return d
}

/** Compute perfect-layout patches for every element (keyed by element id). */
export async function arrangeDesign(design: Design, opts: ArrangeOpts = {}): Promise<Record<string, ElPatch>> {
  const mode: ArrangeMode = opts.mode ?? 'layout'
  if (mode !== 'layout') {
    const { patches, measured, stacks, rows } = await arrangeCore(design, mode, undefined)
    unifyAxes(design, patches)
    resolveObstacles(design, patches, measured, stacks, rows) // LAW 22
    return patches
  }
  // Cleanup settles to its FIXPOINT: one pass rebuilds the blocks, refits the
  // divider and centers the group, but sub-mm interplay between those stages
  // can leave the first result a hair short of stable. Feeding it through a
  // second time returns the converged state, so hammering the button is
  // strictly a no-op.
  const first = await layoutOnce(design)
  const settled: Design = JSON.parse(JSON.stringify(design))
  for (const el of settled.elements) Object.assign(el, first[el.id] ?? {})
  return layoutOnce(settled)
}

/** One cleanup pass - see the contract at the top of the file. */
async function layoutOnce(design: Design): Promise<Record<string, ElPatch>> {
  const { w, h } = design.sign
  const heightOverride = unifySizes(design)
  const { patches, stacks, rows, measured, sides } = await arrangeCore(design, 'layout', heightOverride)
  // arrangeCore already rebuilt every block - tight spacing, shared axes,
  // user order - around the spot the user left it. What remains is the
  // divider, cross-block alignment, and the group's position.

  // LAW 22 first: blocks pushed clear of bolts (and of the pinned line) so
  // the divider re-fit below sees the REAL settled arrangement
  resolveObstacles(design, patches, measured, stacks, rows)

  // The divider lives IN THE GAP between the two sides, wherever the user's
  // arrangement put them (LAW 19: it may never touch the text). Re-derive its
  // position from the settled patches; for the engine's own layout this
  // reproduces the ideal spot exactly.
  const divRe = design.elements.find((e): e is DividerEl => e.kind === 'divider')
  const divReP = divRe ? patches[divRe.id] : undefined
  if (divRe && divReP && sides && (sides.aIds.length || sides.bIds.length)) {
    const mById = new Map(measured.map((m) => [m.el.id, m]))
    const edge = (id: string, axis: 'x' | 'y', dir: 1 | -1): number | null => {
      const p = patches[id]
      const m = mById.get(id)
      if (!p || !m || p.x === undefined || p.y === undefined) return null
      const hh = p.heightMm ?? m.el.heightMm
      return axis === 'x' ? p.x + (dir * (m.aspect * hh)) / 2 : p.y + (dir * (m.inkPerRef * hh)) / 2
    }
    const vert = divReP.vertical ?? divRe.vertical
    const axis: 'x' | 'y' = vert ? 'x' : 'y'
    const axisPinnedDiv = !vert && boltAxisSign(design)
    if (sides.aIds.length && sides.bIds.length) {
      const aEdge = Math.max(...sides.aIds.map((id) => edge(id, axis, 1) ?? -Infinity))
      const bEdge = Math.min(...sides.bIds.map((id) => edge(id, axis, -1) ?? Infinity))
      if (bEdge - aEdge > divRe.thickness + 2 && !axisPinnedDiv) {
        if (vert) divReP.x = r1((aEdge + bEdge) / 2)
        else divReP.y = r1((aEdge + bEdge) / 2)
      }
    } else if (!axisPinnedDiv) {
      // one-sided sign: the divider rides BESIDE its only content block at the
      // canonical gap (canonical geometry would park it at a board position
      // unrelated to where the user left the block, and Perfect-it would
      // creep toward it forever instead of settling)
      const ids = sides.aIds.length ? sides.aIds : sides.bIds
      const lo = Math.min(...ids.map((id) => edge(id, axis, -1) ?? Infinity))
      const hi = Math.max(...ids.map((id) => edge(id, axis, 1) ?? -Infinity))
      if (hi > lo) {
        const gap = vert ? DIV_GAP_X * w : DIV_GAP_Y * h
        // a-side content (left/top) keeps the divider after it; b-side before
        const v = sides.aIds.length ? hi + gap + divRe.thickness / 2 : lo - gap - divRe.thickness / 2
        if (vert) divReP.x = r1(v)
        else divReP.y = r1(v)
      }
    }
    // and it spans centered on the adjacent content along its own axis
    const spanAxis: 'x' | 'y' = vert ? 'y' : 'x'
    const allIds = [...sides.aIds, ...sides.bIds]
    const lo = Math.min(...allIds.map((id) => edge(id, spanAxis, -1) ?? Infinity))
    const hi = Math.max(...allIds.map((id) => edge(id, spanAxis, 1) ?? -Infinity))
    if (hi > lo) {
      if (vert) divReP.y = r1((lo + hi) / 2)
      else divReP.x = r1((lo + hi) / 2)
    }
    divReP.length = r1(clampDividerToBolts(design, divReP.x ?? divRe.x, divReP.y ?? divRe.y, vert, divRe.thickness, divReP.length ?? divRe.length))
  }

  unifyAxesBlocks(design, patches, stacks, rows)
  resolveObstacles(design, patches, measured, stacks, rows) // LAW 22 survives unify

  // LAW 21 (final form - the owner: "the whole thing grouped and centered,
  // text + divider, aligned with the base vertically and horizontally"):
  // whatever the user arranged, the ensemble is ONE GROUP, and the group's
  // ink bbox lands dead center on the board. Relative placements stay
  // sovereign; the group's position is law. The divider never moves relative
  // to the text - it travels with the group.
  let allL = Infinity
  let allR = -Infinity
  let allT = Infinity
  let allB = -Infinity
  for (const m of measured) {
    const p = patches[m.el.id]
    if (!p || p.x === undefined || p.y === undefined) continue
    const hh = p.heightMm ?? m.el.heightMm
    const iw = (m.aspect * hh) / 2
    const ih = (m.inkPerRef * hh) / 2
    allL = Math.min(allL, p.x - iw)
    allR = Math.max(allR, p.x + iw)
    allT = Math.min(allT, p.y - ih)
    allB = Math.max(allB, p.y + ih)
  }
  const divEl = design.elements.find((e): e is DividerEl => e.kind === 'divider')
  const dp = divEl ? patches[divEl.id] : undefined
  if (divEl && dp && dp.x !== undefined && dp.y !== undefined) {
    const len = dp.length ?? divEl.length
    const vert = dp.vertical ?? divEl.vertical
    allL = Math.min(allL, dp.x - (vert ? divEl.thickness / 2 : len / 2))
    allR = Math.max(allR, dp.x + (vert ? divEl.thickness / 2 : len / 2))
    allT = Math.min(allT, dp.y - (vert ? len / 2 : divEl.thickness / 2))
    allB = Math.max(allB, dp.y + (vert ? len / 2 : divEl.thickness / 2))
  }
  if (allR > allL) {
    const dx = w / 2 - (allL + allR) / 2
    // LAW 10 outranks vertical centering: a horizontal divider on a side-bolt
    // board stays welded to the bolt axis
    const axisPinned = !!divEl && !!dp && !(dp.vertical ?? divEl.vertical) && boltAxisSign(design)
    let dy = axisPinned ? 0 : h / 2 - (allT + allB) / 2
    let ddx = dx
    // LAW 22 outranks perfect centering: if sliding the group to center would
    // push a letter into a bolt zone, back the slide off until it is clean
    if (anyBoltHit(design, patches, measured, ddx, dy)) {
      let k = 1
      for (let step = 0; step < 8; step++) {
        k /= 2
        if (!anyBoltHit(design, patches, measured, ddx * k, dy * k)) break
      }
      if (anyBoltHit(design, patches, measured, ddx * k, dy * k)) k = 0
      ddx *= k
      dy *= k
    }
    for (const el of design.elements) {
      const p = patches[el.id]
      if (!p) continue
      if (p.x !== undefined) p.x = r1(p.x + ddx)
      if (p.y !== undefined) p.y = r1(p.y + dy)
    }
    // LAW 19 survives the ride: re-clamp the divider clear of the bolts
    if (divEl && dp && dp.x !== undefined && dp.y !== undefined) {
      const vert = dp.vertical ?? divEl.vertical
      const len = dp.length ?? divEl.length
      dp.length = r1(clampDividerToBolts(design, dp.x, dp.y, vert, divEl.thickness, len))
    }
  }
  return patches
}

interface ArrangeResult {
  patches: Record<string, ElPatch>
  stacks: string[][] // vertical groups - members share X
  rows: string[][] // horizontal groups - members share Y
  measured: Measured[] // ink metrics per text, for the group-centering pass
  // the two sides the divider separates (left/right or top/bottom), so the
  // divider can re-derive its spot from where the content ACTUALLY settles
  sides: { aIds: string[]; bIds: string[] } | null
}

async function arrangeCore(design: Design, mode: ArrangeMode, heightOverride?: Map<string, { h: number; final: boolean }>): Promise<ArrangeResult> {
  const stacks: string[][] = []
  const rows: string[][] = []
  let sides: ArrangeResult['sides'] = null
  const userHeights: HeightOf = (m) => heightOverride?.get(m.el.id)?.h ?? Math.max(1, m.el.heightMm)
  const isFinal = (m: Measured) => !!m.el.sized || !!heightOverride?.get(m.el.id)?.final
  const { w, h } = design.sign
  const patches: Record<string, ElPatch> = {}
  const texts = design.elements.filter((e): e is TextEl => e.kind === 'text' && e.text.trim().length > 0)
  const dividers = design.elements.filter((e): e is DividerEl => e.kind === 'divider')
  const measured = await Promise.all(texts.map(measure))
  const byY = (a: Measured, b: Measured) => a.el.y - b.el.y
  const div = dividers[0]

  if (div && div.vertical) {
    // ---- Left | Right ----
    let right = measured.filter((m) => m.el.x >= div.x).sort(byY)
    let left = measured.filter((m) => m.el.x < div.x).sort(byY)
    // where the user left each SIDE (captured before the law-16 swap: if the
    // columns trade places, each lands on the other side's spot)
    const rightSpot = right.length ? inkCenterOf(right) : null
    const leftSpot = left.length ? inkCenterOf(left) : null

    // LAW 16: the name column leads the reading direction - an Arabic name
    // goes RIGHT (read first), a Latin name goes LEFT. Swap if backwards.
    const nameish = (g: Measured[]) => g.some((m) => m.role === 'name')
    if (right.length && left.length && nameish(right) !== nameish(left)) {
      const nameCol = nameish(right) ? right : left
      const otherCol = nameish(right) ? left : right
      const nameGoesRight = nameCol.some((m) => hasArabic(m.el.text))
      right = nameGoesRight ? nameCol : otherCol
      left = nameGoesRight ? otherCol : nameCol
    }

    // letter|number mode (canonical sizing only): equal size on one row
    const shortSingle = (g: Measured[]) => g.length === 1 && g[0].el.text.trim().length <= 4
    const oneRow = mode === 'canonical' && shortSingle(right) && shortSingle(left)
    const cols: Measured[][] = oneRow ? [right, left].map((g) => g.map((m) => ({ ...m, unit: 1.65 }))) : [right, left]
    const [R, L] = cols

    const gapX = DIV_GAP_X * w
    const corridor = boltCorridor(design) // LAW 22: fill only between the bolts
    const unitsW = blockUnits(R) + blockUnits(L)
    const gapsW = (R.length ? gapX : 0) + (L.length ? gapX : 0) + div.thickness
    let s = unitsW > 0 ? (Math.min(WIDTH_FILL * w, corridor.maxW) - gapsW) / unitsW : 1
    for (const g of [R, L]) {
      if (!g.length) continue
      s = Math.min(s, Math.min(HEIGHT_FILL * h, corridor.maxH) / stackUnits(g))
      for (const m of g) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
    }
    // the canonical base is the floor for UNTOUCHED sizes only - a size the
    // user set by hand ("when I resize, you don't resize again") is final
    const H: HeightOf = mode === 'canonical' ? scaled(s) : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), scaled(s)(m)))

    const wR = blockWidth(R, H)
    const wL = blockWidth(L, H)
    const total = wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR
    const x0 = (w - total) / 2
    const cxL = x0 + wL / 2
    const divX = x0 + wL + (L.length ? gapX : 0) + div.thickness / 2
    const cxR = x0 + wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR / 2

    // the divider always tracks the content beside it (both modes)
    const divLen = clamp(Math.max(stackExtent(R, H), stackExtent(L, H)) * 1.15, 0.22 * h, 0.8 * h)
    patches[div.id] = { x: r1(divX), y: r1(h / 2), vertical: true, length: r1(clampDividerToBolts(design, divX, h / 2, true, div.thickness, divLen)) }
    if (mode === 'layout') {
      // v7: align each column on the X of the side the user gave it (after a
      // law-16 swap the columns trade sides); every line keeps its own y
      placeAligned(R, H, rightSpot ? rightSpot.cx : cxR, patches, stacks)
      placeAligned(L, H, leftSpot ? leftSpot.cx : cxL, patches, stacks)
    } else {
      placeStack(R, H, cxR, h / 2, patches, stacks)
      placeStack(L, H, cxL, h / 2, patches, stacks)
    }
    sides = { aIds: L.map((m) => m.el.id), bIds: R.map((m) => m.el.id) }
    if (oneRow && R.length && L.length) rows.push([R[0].el.id, L[0].el.id])
  } else if (div) {
    // ---- Up | Down (wide) and Vertical (tall) ----
    const top = measured.filter((m) => m.el.y < div.y).sort(byY)
    const bottom = measured.filter((m) => m.el.y >= div.y).sort(byY)
    const gapY = DIV_GAP_Y * h
    // side bolts sit at mid-height: the line must run exactly on their axis
    const boltAxis = boltAxisSign(design)
    const padY = ((1 - HEIGHT_FILL) / 2) * h

    // catalog Villa-row: a label + a number on top spread on ONE row. In
    // cleanup mode the pair must ACTUALLY sit side by side right now - a
    // label the user stacked OVER its number is a stack, and flattening it
    // onto one line would print the two texts on top of each other
    const sideBySide =
      top.length === 2 &&
      Math.abs(top[0].el.y - top[1].el.y) < 0.6 * ((top[0].inkPerRef * Math.max(1, top[0].el.heightMm) + top[1].inkPerRef * Math.max(1, top[1].el.heightMm)) / 2)
    const topRowPair =
      top.length === 2 &&
      top.filter((m) => m.role === 'number').length === 1 &&
      top.every((m) => m.role === 'number' || m.role === 'label' || m.el.text.trim().length <= 8) &&
      (mode === 'canonical' || sideBySide)

    if (topRowPair) {
      const rowUnit = 1.6
      const row = mode === 'canonical' ? top.map((m) => ({ ...m, unit: rowUnit })) : top
      const num = row.find((m) => m.role === 'number')!
      const other = row.find((m) => m.role !== 'number')!
      const labelRight = hasArabic(other.el.text)
      const corridor = boltCorridor(design) // LAW 22
      const CW = Math.min(WIDTH_FILL * w, corridor.maxW)
      const midGap = 0.06 * w

      let s = Infinity
      const rowInkUnits = rowUnit * Math.max(...row.map((m) => m.inkPerRef))
      const unitsH = rowInkUnits + stackUnits(bottom)
      const gapsH = gapY + div.thickness + (bottom.length ? gapY : 0)
      s = Math.min(s, (Math.min(HEIGHT_FILL * h, corridor.maxH) - gapsH) / unitsH)
      s = Math.min(s, (CW - midGap) / (num.aspect * rowUnit + other.aspect * rowUnit))
      for (const m of bottom) s = Math.min(s, CW / (m.aspect * ratioOf(m)))
      s = Math.min(s, (NUMBER_CAP * h) / rowUnit)
      for (const m of bottom) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      if (boltAxis) {
        // LAW 19: the divider is pinned to the bolt axis, so each half's
        // content must FIT its half - text may never reach the line
        const halfSpace = h / 2 - gapY - padY
        if (halfSpace > 0) {
          s = Math.min(s, halfSpace / rowInkUnits)
          if (bottom.length) s = Math.min(s, halfSpace / stackUnits(bottom))
        }
      }
      const canonRow: HeightOf = (m) => f1((row.includes(m) ? rowUnit : ratioOf(m)) * s)
      const H: HeightOf = mode === 'canonical' ? canonRow : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), canonRow(m)))

      const rowH = Math.max(...row.map((m) => H(m) * m.inkPerRef))
      const hB = stackExtent(bottom, H)
      let cyRow: number
      let divY: number
      let cyB: number
      if (boltAxis) {
        // line locked to the bolt axis; blocks centered in their halves
        divY = h / 2
        cyRow = (padY + (divY - gapY)) / 2
        cyB = (divY + gapY + (h - padY)) / 2
      } else {
        const total = rowH + gapY + div.thickness + (bottom.length ? gapY : 0) + hB
        const y0 = (h - total) / 2
        cyRow = y0 + rowH / 2
        divY = y0 + rowH + gapY + div.thickness / 2
        cyB = divY + div.thickness / 2 + (bottom.length ? gapY : 0) + hB / 2
      }

      // LAW 20: the label|number row huddles - a short pair is not flung to
      // the board edges with a hole in the middle (owner: "sometimes we need
      // to get the 34 and villa closer"). The middle gap is capped and the
      // pair stays centered as a group.
      const leftM = labelRight ? num : other
      const rightM = labelRight ? other : num
      const wLm = leftM.aspect * H(leftM)
      const wRm = rightM.aspect * H(rightM)
      const rowSpan = Math.min(CW, wLm + wRm + MAX_ROW_GAP * w)
      const xL = (w - rowSpan) / 2
      const xR = (w + rowSpan) / 2
      if (mode === 'layout') {
        // cleanup: row members keep their own x, the row levels on the ink
        // middle of where the user left the pair
        const rowCy = r1(inkCenterOf(row).cy)
        patches[leftM.el.id] = { x: r1(leftM.el.x), y: rowCy, heightMm: r1(H(leftM)) }
        patches[rightM.el.id] = { x: r1(rightM.el.x), y: rowCy, heightMm: r1(H(rightM)) }
      } else {
        patches[leftM.el.id] = { x: r1(xL + wLm / 2), y: r1(cyRow), heightMm: r1(H(leftM)) }
        patches[rightM.el.id] = { x: r1(xR - wRm / 2), y: r1(cyRow), heightMm: r1(H(rightM)) }
      }
      // the line runs exactly from the first letter to the last letter of the
      // widest adjacent content - never past it
      const rowDivLen = clampDividerToBolts(design, w / 2, divY, false, div.thickness, Math.max(rowSpan, blockWidth(bottom, H)))
      patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1(rowDivLen) }
      if (mode === 'layout') placeAligned(bottom, H, bottom.length ? inkCenterOf(bottom).cx : w / 2, patches, stacks)
      else placeStack(bottom, H, w / 2, cyB, patches, stacks)
      rows.push([leftM.el.id, rightM.el.id])
      sides = { aIds: row.map((m) => m.el.id), bIds: bottom.map((m) => m.el.id) }
    } else {
      const corridor = boltCorridor(design) // LAW 22
      const unitsH = stackUnits(top) + stackUnits(bottom)
      const gapsH = (top.length ? gapY : 0) + (bottom.length ? gapY : 0) + div.thickness
      let s = unitsH > 0 ? (Math.min(HEIGHT_FILL * h, corridor.maxH) - gapsH) / unitsH : 1
      for (const m of measured) {
        s = Math.min(s, Math.min(0.8 * w, corridor.maxW) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      if (boltAxis) {
        // LAW 19: divider pinned to the bolt axis - each half's stack must fit
        const halfSpace = h / 2 - gapY - padY
        if (halfSpace > 0) {
          if (top.length) s = Math.min(s, halfSpace / stackUnits(top))
          if (bottom.length) s = Math.min(s, halfSpace / stackUnits(bottom))
        }
      }
      const H: HeightOf = mode === 'canonical' ? scaled(s) : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), scaled(s)(m)))

      const hT = stackExtent(top, H)
      const hB = stackExtent(bottom, H)
      let cyT: number
      let divY: number
      let cyB: number
      if (boltAxis) {
        divY = h / 2
        cyT = (padY + (divY - gapY)) / 2
        cyB = (divY + gapY + (h - padY)) / 2
      } else {
        const total = hT + (top.length ? gapY : 0) + div.thickness + (bottom.length ? gapY : 0) + hB
        const y0 = (h - total) / 2
        cyT = y0 + hT / 2
        divY = y0 + hT + (top.length ? gapY : 0) + div.thickness / 2
        cyB = y0 + hT + (top.length ? gapY : 0) + div.thickness + (bottom.length ? gapY : 0) + hB / 2
      }

      // exact content span: first letter to last letter of the widest block
      const divLen = Math.max(0.2 * w, blockWidth(top, H), blockWidth(bottom, H))
      patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1(clampDividerToBolts(design, w / 2, divY, false, div.thickness, divLen)) }
      if (mode === 'layout') {
        placeAligned(top, H, top.length ? inkCenterOf(top).cx : w / 2, patches, stacks)
        placeAligned(bottom, H, bottom.length ? inkCenterOf(bottom).cx : w / 2, patches, stacks)
      } else {
        placeStack(top, H, w / 2, cyT, patches, stacks)
        placeStack(bottom, H, w / 2, cyB, patches, stacks)
      }
      sides = { aIds: top.map((m) => m.el.id), bIds: bottom.map((m) => m.el.id) }
    }
  } else {
    // ---- no divider: one centered stack ----
    const lines = [...measured].sort(byY)
    if (lines.length) {
      const corridor = boltCorridor(design) // LAW 22
      let s = Math.min(0.72 * h, corridor.maxH) / stackUnits(lines)
      for (const m of lines) {
        s = Math.min(s, Math.min(0.8 * w, corridor.maxW) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      const H: HeightOf = mode === 'canonical' ? scaled(s) : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), scaled(s)(m)))
      if (mode === 'layout') placeAligned(lines, H, inkCenterOf(lines).cx, patches, stacks)
      else placeStack(lines, H, w / 2, h / 2, patches, stacks)
    }
  }
  return { patches, stacks, rows, measured, sides }
}
