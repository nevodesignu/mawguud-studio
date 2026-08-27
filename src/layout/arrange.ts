// The layout brain behind "Perfect it" and the Sign Bot - v5.
//
// THE CONTRACT (the owner's words: "I do the sizing - just make the sign
// ready"): two modes.
//
//   'layout'    - Perfect-it. NEVER touches a text size, and NEVER moves a
//                 hand-placed element off its spot ("let me place it where i
//                 want - anything - but make sure its aligned correctly").
//                 Takes what the user set and does pure geometry around it:
//                 ink-aware tight stacking, blocks centered beside the
//                 divider, divider content-matched, alignment laws anchored
//                 on the user's placements.
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

// LAW 18: the number leads the sign but never dwarfs it. The raw production
// files ran numbers at 2.0x a name / 30% of board height - the owner called
// that "super huge". 1.45x + the 24% NUMBER_CAP keeps the number the first
// thing you find without turning the sign into a parking plate.
const RATIO: Record<'name' | 'number' | 'label', number> = { name: 1.0, number: 1.45, label: 0.85 }
const STACK_GAP = 0.18 // ink gap between lines, fraction of mean line height
// LAW 11: text as big as possible on every sign - but readable, never bloated.
// The fills push size up; NUMBER_CAP / LINE_CAP are the "not too big" guards.
const WIDTH_FILL = 0.84 // canonical ensemble width target
const HEIGHT_FILL = 0.78 // canonical ensemble height cap
const DIV_GAP_X = 0.045 // gap between divider and each block, fraction of W
const DIV_GAP_Y = 0.05 // for horizontal dividers, fraction of H
const MAX_ROW_GAP = 0.12 // LAW 20: villa-row middle gap cap, fraction of W
const LINE_CAP = 0.4
const NUMBER_CAP = 0.24

export type ArrangeMode = 'layout' | 'canonical'

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
  // hand-placed elements are the anchors: a cluster snaps to where the USER
  // put things, never pulls the user's element toward an engine position
  const anchors = new Set(design.elements.filter((e) => e.kind === 'text' && e.placed).map((e) => e.id))
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
        const cluster = items.slice(i, j + 1)
        const src = cluster.filter((it) => anchors.has(it.id))
        const from = src.length ? src : cluster
        const mean = r1(from.reduce((a, b) => a + b.v, 0) / from.length)
        for (let k = i; k <= j; k++) patches[items[k].id][axis] = mean
      }
      i = j + 1
    }
  }
}

/**
 * LAW 15: sibling texts of the same kind at ALMOST the same size were meant to
 * be equal - unify them UP to the biggest (sizes stay sovereign when clearly
 * different, and nothing ever shrinks).
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
  const { w, h } = design.sign
  const heightOverride = mode === 'layout' ? unifySizes(design) : undefined
  const { patches, stacks, rows } = await arrangeCore(design, mode, heightOverride)
  if (mode !== 'layout') {
    unifyAxes(design, patches)
    // the bot re-designs from scratch: its placements are not the user's hand,
    // so hand-placement flags reset with it
    for (const el of design.elements) {
      if (el.kind === 'text' && patches[el.id]) patches[el.id].placed = false
    }
    return patches
  }
  // Understand the user's mind: an element sitting CLOSE to its ideal spot was
  // deliberately nudged there ("a bit upward, slightly to the side") - keep it.
  // An element far from ideal is asking to be placed properly. Alignment laws
  // survive nudging: stacked texts always share X (a sideways nudge moves the
  // whole column), side-by-side texts always share Y (a vertical nudge moves
  // the whole row).
  const NUDGE_KEEP = Math.max(8, 0.04 * Math.min(w, h))
  const byId = new Map(design.elements.map((e) => [e.id, e]))
  const inStack = new Set(stacks.flat())
  const inRow = new Set(rows.flat())
  const isPlaced = (id: string) => {
    const el = byId.get(id)
    return el?.kind === 'text' && !!el.placed
  }
  // members of a stack/row that contains a hand-placed anchor: their position
  // comes purely from the anchor translation below - per-element nudge keeps
  // must not fight it, or the group settles differently on the next pass
  const anchorFollowers = new Set(
    [...stacks, ...rows].filter((g) => g.some(isPlaced)).flat(),
  )

  for (const el of design.elements) {
    if (el.kind === 'divider') continue // divider position is law (bolt axis, content flush)
    const p = patches[el.id]
    if (!p || p.x === undefined || p.y === undefined) continue
    if (anchorFollowers.has(el.id) && !el.placed) continue
    // PLACEMENT SOVEREIGNTY (the owner: "let me place it where i want -
    // anything - but make sure its aligned correctly"): a hand-placed element
    // is FINAL, any distance. Alone it keeps its exact spot; in a stack/row
    // the whole group translates onto it below, so the alignment laws still
    // hold - anchored on the user's position, not the engine's.
    if (el.placed) {
      if (!inStack.has(el.id) && !inRow.has(el.id)) {
        p.x = el.x
        p.y = el.y
      }
      continue
    }
    const dx = el.x - p.x
    const dy = el.y - p.y
    if (!inStack.has(el.id) && Math.abs(dx) <= NUDGE_KEEP && Math.abs(dy) <= NUDGE_KEEP) p.x = el.x
    if (!inRow.has(el.id) && Math.abs(dx) <= NUDGE_KEEP && Math.abs(dy) <= NUDGE_KEEP) p.y = el.y
  }
  // LAW 12: a stack shares one X - keep the group's common sideways nudge.
  // A hand-placed line anchors its whole column: the stack translates onto it
  // (spacing and shared X intact), no distance cap.
  for (const group of stacks) {
    const anchors = group.filter(isPlaced)
    if (anchors.length) {
      const adx = anchors.reduce((a, id) => a + ((byId.get(id)?.x ?? 0) - (patches[id]?.x ?? 0)), 0) / anchors.length
      const ady = anchors.reduce((a, id) => a + ((byId.get(id)?.y ?? 0) - (patches[id]?.y ?? 0)), 0) / anchors.length
      for (const id of group) {
        const p = patches[id]
        if (p && p.x !== undefined) p.x = r1(p.x + adx)
        if (p && p.y !== undefined) p.y = r1(p.y + ady)
      }
      continue
    }
    const deltas = group.map((id) => (byId.get(id)?.x ?? 0) - (patches[id]?.x ?? 0))
    const common = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const shift = Math.abs(common) <= NUDGE_KEEP ? common : 0
    for (const id of group) {
      const p = patches[id]
      if (p && p.x !== undefined) p.x = r1(p.x + shift)
    }
  }
  // LAW 13: a row shares one Y - keep the group's common vertical nudge.
  // A hand-placed member anchors the row's Y and keeps its own X exactly.
  for (const group of rows) {
    const anchors = group.filter(isPlaced)
    if (anchors.length) {
      const ady = anchors.reduce((a, id) => a + ((byId.get(id)?.y ?? 0) - (patches[id]?.y ?? 0)), 0) / anchors.length
      for (const id of group) {
        const p = patches[id]
        if (p && p.y !== undefined) p.y = r1(p.y + ady)
      }
      for (const id of anchors) {
        const p = patches[id]
        const el = byId.get(id)
        if (p && el) p.x = el.x
      }
      continue
    }
    const deltas = group.map((id) => (byId.get(id)?.y ?? 0) - (patches[id]?.y ?? 0))
    const common = deltas.reduce((a, b) => a + b, 0) / deltas.length
    const shift = Math.abs(common) <= NUDGE_KEEP ? common : 0
    for (const id of group) {
      const p = patches[id]
      if (p && p.y !== undefined) p.y = r1(p.y + shift)
    }
  }
  unifyAxes(design, patches)
  return patches
}

interface ArrangeResult {
  patches: Record<string, ElPatch>
  stacks: string[][] // vertical groups - members share X
  rows: string[][] // horizontal groups - members share Y
}

async function arrangeCore(design: Design, mode: ArrangeMode, heightOverride?: Map<string, { h: number; final: boolean }>): Promise<ArrangeResult> {
  const stacks: string[][] = []
  const rows: string[][] = []
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
    const cols: Measured[][] = oneRow ? [right, left].map((g) => g.map((m) => ({ ...m, unit: 1.45 }))) : [right, left]
    const [R, L] = cols

    const gapX = DIV_GAP_X * w
    const sidePad = ((1 - WIDTH_FILL) / 2) * w
    // LAW 21: the divider sits at the CENTER of the sign (owner: "at the end
    // of the day this part gotta be at the center") - each column centers in
    // its own half, however unequal the columns are. A one-column sign keeps
    // whole-composition centering instead.
    const centerDiv = R.length > 0 && L.length > 0
    let s = Infinity
    if (centerDiv) {
      // each column must FIT its half
      const halfW = w / 2 - div.thickness / 2 - gapX - sidePad
      for (const g of [R, L]) {
        const u = blockUnits(g)
        if (u > 0) s = Math.min(s, halfW / u)
      }
    } else {
      const unitsW = blockUnits(R) + blockUnits(L)
      const gapsW = (R.length ? gapX : 0) + (L.length ? gapX : 0) + div.thickness
      s = unitsW > 0 ? (WIDTH_FILL * w - gapsW) / unitsW : 1
    }
    for (const g of [R, L]) {
      if (!g.length) continue
      s = Math.min(s, (HEIGHT_FILL * h) / stackUnits(g))
      for (const m of g) s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
    }
    // the canonical base is the floor for UNTOUCHED sizes only - a size the
    // user set by hand ("when I resize, you don't resize again") is final
    const H: HeightOf = mode === 'canonical' ? scaled(s) : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), scaled(s)(m)))

    const wR = blockWidth(R, H)
    const wL = blockWidth(L, H)
    let cxL: number
    let divX: number
    let cxR: number
    if (centerDiv) {
      // divider dead center; each column centered between the board edge and
      // the divider (the half-fit cap above keeps the divider gap clear)
      divX = w / 2
      cxL = (w / 2 - div.thickness / 2) / 2
      cxR = w - cxL
    } else {
      const total = wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR
      const x0 = (w - total) / 2
      cxL = x0 + wL / 2
      divX = x0 + wL + (L.length ? gapX : 0) + div.thickness / 2
      cxR = x0 + wL + (L.length ? gapX : 0) + div.thickness + (R.length ? gapX : 0) + wR / 2
    }

    // the divider always tracks the content beside it (both modes)
    const divLen = clamp(Math.max(stackExtent(R, H), stackExtent(L, H)) * 1.15, 0.22 * h, 0.8 * h)
    patches[div.id] = { x: r1(divX), y: r1(h / 2), vertical: true, length: r1(clampDividerToBolts(design, divX, h / 2, true, div.thickness, divLen)) }
    placeStack(R, H, cxR, h / 2, patches, stacks)
    placeStack(L, H, cxL, h / 2, patches, stacks)
    if (oneRow && R.length && L.length) rows.push([R[0].el.id, L[0].el.id])
  } else if (div) {
    // ---- Up | Down (wide) and Vertical (tall) ----
    const top = measured.filter((m) => m.el.y < div.y).sort(byY)
    const bottom = measured.filter((m) => m.el.y >= div.y).sort(byY)
    const gapY = DIV_GAP_Y * h
    // side bolts sit at mid-height: the line must run exactly on their axis
    const boltAxis = design.sign.bolts && design.sign.boltPattern === 'sides'
    const padY = ((1 - HEIGHT_FILL) / 2) * h

    // catalog Villa-row: a label + a number on top spread on ONE row
    const topRowPair =
      top.length === 2 &&
      top.filter((m) => m.role === 'number').length === 1 &&
      top.every((m) => m.role === 'number' || m.role === 'label' || m.el.text.trim().length <= 8)

    if (topRowPair) {
      const rowUnit = 1.4
      const row = mode === 'canonical' ? top.map((m) => ({ ...m, unit: rowUnit })) : top
      const num = row.find((m) => m.role === 'number')!
      const other = row.find((m) => m.role !== 'number')!
      const labelRight = hasArabic(other.el.text)
      const CW = WIDTH_FILL * w
      const midGap = 0.06 * w

      let s = Infinity
      const rowInkUnits = rowUnit * Math.max(...row.map((m) => m.inkPerRef))
      const unitsH = rowInkUnits + stackUnits(bottom)
      const gapsH = gapY + div.thickness + (bottom.length ? gapY : 0)
      s = Math.min(s, (HEIGHT_FILL * h - gapsH) / unitsH)
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
      patches[leftM.el.id] = { x: r1(xL + wLm / 2), y: r1(cyRow), heightMm: r1(H(leftM)) }
      patches[rightM.el.id] = { x: r1(xR - wRm / 2), y: r1(cyRow), heightMm: r1(H(rightM)) }
      // the line runs exactly from the first letter to the last letter of the
      // widest adjacent content - never past it
      const rowDivLen = clampDividerToBolts(design, w / 2, divY, false, div.thickness, Math.max(rowSpan, blockWidth(bottom, H)))
      patches[div.id] = { x: r1(w / 2), y: r1(divY), vertical: false, length: r1(rowDivLen) }
      placeStack(bottom, H, w / 2, cyB, patches, stacks)
      rows.push([leftM.el.id, rightM.el.id])
    } else {
      const unitsH = stackUnits(top) + stackUnits(bottom)
      const gapsH = (top.length ? gapY : 0) + (bottom.length ? gapY : 0) + div.thickness
      let s = unitsH > 0 ? (HEIGHT_FILL * h - gapsH) / unitsH : 1
      for (const m of measured) {
        s = Math.min(s, (0.8 * w) / (m.aspect * ratioOf(m)))
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
      placeStack(top, H, w / 2, cyT, patches, stacks)
      placeStack(bottom, H, w / 2, cyB, patches, stacks)
    }
  } else {
    // ---- no divider: one centered stack ----
    const lines = [...measured].sort(byY)
    if (lines.length) {
      let s = (0.72 * h) / stackUnits(lines)
      for (const m of lines) {
        s = Math.min(s, (0.8 * w) / (m.aspect * ratioOf(m)))
        s = Math.min(s, ((m.role === 'number' ? NUMBER_CAP : LINE_CAP) * h) / ratioOf(m))
      }
      const H: HeightOf = mode === 'canonical' ? scaled(s) : (m) => (isFinal(m) ? userHeights(m) : Math.max(userHeights(m), scaled(s)(m)))
      placeStack(lines, H, w / 2, h / 2, patches, stacks)
    }
  }
  return { patches, stacks, rows }
}
