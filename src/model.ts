// Design document model. All dimensions in millimetres.
// Template specs below are measured from Mawguud's real production .ai templates
// (Lighted + Mirror, all layouts/sizes) - bolt sizes, insets, divider thickness.

import type { Pt } from './geom/types'

export type BoltPattern = 'corners' | 'sides'

export interface SignSpec {
  w: number
  h: number
  radius: number
  bolts: boolean
  boltDia: number
  boltInsetX: number
  boltInsetY: number
  boltPattern: BoltPattern
}

export interface TextEl {
  id: string
  kind: 'text'
  text: string
  fontId: string
  heightMm: number // height of a standard tall letter (alef/H)
  sized?: boolean // true once the USER set the size by hand - then it is final
  placed?: boolean // true once the USER moved it by hand - the position is final too
  groupId?: string // elements sharing a groupId select and move as one
  x: number // centre of ink bbox
  y: number
  spacingEm: number // extra tracking, fraction of em (never applied inside Arabic joins)
}

export interface DividerEl {
  id: string
  kind: 'divider'
  groupId?: string // elements sharing a groupId select and move as one
  x: number // centre
  y: number
  length: number
  thickness: number
  vertical: boolean
  roundCaps: boolean
}

export type El = TextEl | DividerEl

export type ExportStyle = 'mawguud' | 'filled' | 'redline'

export interface FinalizeSettings {
  bridgeWidth: number
  clearance: number
  minHoleArea: number
  exportStyle: ExportStyle
}

export interface Design {
  id: string
  name: string
  sign: SignSpec
  elements: El[]
  fin: FinalizeSettings
  bridgeOverrides: Record<string, number>
  updatedAt: number
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export const defaultFin: FinalizeSettings = { bridgeWidth: 1.2, clearance: 1.5, minHoleArea: 3, exportStyle: 'mawguud' }

/** Bolt hole centres for a sign, in design mm. */
export function boltCenters(sign: SignSpec): Pt[] {
  if (!sign.bolts) return []
  const { w, h, boltInsetX: ix, boltInsetY: iy } = sign
  if (sign.boltPattern === 'sides') {
    return [
      [ix, h / 2],
      [w - ix, h / 2],
    ]
  }
  return [
    [ix, iy],
    [w - ix, iy],
    [w - ix, h - iy],
    [ix, h - iy],
  ]
}

/** Migrate designs saved by older versions of the app. */
export function normalizeDesign(d: Design): Design {
  const sign = d.sign as SignSpec & { mountHoles?: boolean; holeDia?: number; holeInset?: number }
  if (sign.bolts === undefined) {
    sign.bolts = sign.mountHoles ?? true
    sign.boltDia = sign.holeDia ?? 6.6
    sign.boltInsetX = sign.holeInset ?? 23.6
    sign.boltInsetY = sign.holeInset ?? 23.6
    sign.boltPattern = 'corners'
  }
  if (!d.fin.exportStyle) d.fin.exportStyle = 'mawguud'
  return d
}

export function makeDesign(name: string, sign: SignSpec, elements: El[]): Design {
  return {
    id: uid(),
    name,
    sign,
    elements,
    fin: { ...defaultFin },
    bridgeOverrides: {},
    updatedAt: Date.now(),
  }
}

const text = (t: string, fontId: string, heightMm: number, x: number, y: number): TextEl => ({
  id: uid(),
  kind: 'text',
  text: t,
  fontId,
  heightMm: Math.round(heightMm * 10) / 10,
  x: Math.round(x * 10) / 10,
  y: Math.round(y * 10) / 10,
  spacingEm: 0,
})

const divider = (x: number, y: number, length: number, thickness: number, vertical: boolean): DividerEl => ({
  id: uid(),
  kind: 'divider',
  x: Math.round(x * 10) / 10,
  y: Math.round(y * 10) / 10,
  length: Math.round(length * 10) / 10,
  thickness,
  vertical,
  roundCaps: false,
})

// ---------------- real Mawguud template catalog ----------------

export type Finish = 'lighted' | 'mirror'
export type Layout = 'leftright' | 'updown' | 'vertical'

export interface TemplateSpec {
  finish: Finish
  layout: Layout
  w: number // mm
  h: number
  boltDia: number
  boltInsetX: number
  boltInsetY: number
  boltPattern: BoltPattern
  divThick: number
  radius: number // board corner fillet - the real boards are rounded
}

const cornerR = (w: number, h: number) => (Math.max(w, h) <= 400 ? 2.5 : 3.5)

const L = (layout: Layout, w: number, h: number, divThick = 2.5): TemplateSpec => ({
  finish: 'lighted',
  layout,
  w,
  h,
  boltDia: 13.0,
  boltInsetX: 32.5,
  boltInsetY: 32.5,
  boltPattern: 'corners',
  divThick,
  radius: cornerR(w, h),
})

const M = (layout: Layout, w: number, h: number, boltDia: number, inset: number, divThick: number, pattern: BoltPattern = 'corners'): TemplateSpec => ({
  finish: 'mirror',
  layout,
  w,
  h,
  boltDia,
  boltInsetX: inset,
  boltInsetY: pattern === 'sides' ? h / 2 : inset,
  boltPattern: pattern,
  divThick,
  radius: cornerR(w, h),
})

export const templateCatalog: TemplateSpec[] = [
  // ALL VALUES RE-MEASURED 2026-08-27 from the owner's 27 production .ai files
  // (the full template pack). Every number is the CUT PATH itself - the earlier
  // catalog measured the stroked outline, so every hole and bar ran ~0.35mm
  // (one 1pt stroke) oversize.
  // Lighted - bolts constant across every size: dia 13.0, inset 32.5
  L('leftright', 400, 250),
  L('leftright', 500, 300),
  L('leftright', 600, 350),
  L('leftright', 700, 400),
  L('updown', 400, 250),
  L('updown', 500, 300, 3.0),
  L('updown', 600, 350, 3.0),
  L('updown', 700, 400, 3.0),
  L('vertical', 250, 400),
  L('vertical', 300, 500),
  L('vertical', 350, 600),
  L('vertical', 400, 700),
  // Mirror - bolts scale with the board's long side (inset = 5.82% of it);
  // the 30cm boards use 2 bolts at mid-height instead of 4 corners
  M('leftright', 300, 150, 6.5, 15.0, 2.25, 'sides'),
  M('leftright', 400, 200, 6.2, 23.3, 2.5),
  M('leftright', 500, 250, 6.5, 29.1, 2.6),
  M('leftright', 600, 300, 7.0, 34.9, 2.7),
  M('leftright', 700, 350, 7.5, 40.7, 2.9),
  M('updown', 300, 150, 6.0, 18.0, 2.4, 'sides'),
  M('updown', 400, 200, 6.2, 23.3, 2.5),
  M('updown', 500, 250, 6.5, 29.1, 2.7),
  M('updown', 600, 300, 7.0, 34.9, 2.8),
  M('updown', 700, 350, 7.5, 40.7, 2.9),
  M('vertical', 150, 300, 6.0, 14.0, 2.3, 'sides'),
  M('vertical', 200, 400, 6.2, 23.3, 2.5),
  M('vertical', 250, 500, 6.5, 29.1, 2.7),
  M('vertical', 300, 600, 7.0, 34.9, 2.7),
  M('vertical', 350, 700, 7.5, 40.7, 2.9),
]

export const finishLabel: Record<Finish, string> = { lighted: 'Lighted', mirror: 'Mirror' }
export const layoutLabel: Record<Layout, string> = { leftright: 'Left | Right', updown: 'Up | Down', vertical: 'Vertical' }

// Defaults for seeded text: the real Mawguud production font for Arabic,
// Century Gothic Bold for numbers/Latin (their geometric-sans look).
const AR = 'avenir-arabic-medium'
const NUM = 'century-gothic-bold'

export function signFromSpec(spec: TemplateSpec): SignSpec {
  return {
    w: spec.w,
    h: spec.h,
    radius: spec.radius, // measured fillet - every real board is rounded (2.5 / 3.5mm)
    bolts: true,
    boltDia: spec.boltDia,
    boltInsetX: spec.boltInsetX,
    boltInsetY: spec.boltInsetY,
    boltPattern: spec.boltPattern,
  }
}

export const specName = (spec: TemplateSpec) =>
  `${finishLabel[spec.finish]} ${layoutLabel[spec.layout]} ${spec.w / 10}x${spec.h / 10}`

export function makeFromSpec(spec: TemplateSpec): Design {
  const { w, h } = spec
  const sign = signFromSpec(spec)
  const els: El[] = []
  if (spec.layout === 'leftright') {
    els.push(divider(w / 2, h / 2, h * 0.64, spec.divThick, true))
    els.push(text('أ / محروس', AR, h * 0.1, w * 0.75, h * 0.4))
    els.push(text('عبد الحميد', AR, h * 0.1, w * 0.75, h * 0.57))
    els.push(text('منيل', AR, h * 0.1, w * 0.25, h * 0.4))
    els.push(text('جويدة', AR, h * 0.1, w * 0.25, h * 0.57))
  } else if (spec.layout === 'updown') {
    els.push(text('34', NUM, h * 0.18, w / 2, h * 0.3))
    els.push(divider(w / 2, h / 2, w * 0.66, spec.divThick, false))
    els.push(text('المهندس عبيد محمد', AR, h * 0.12, w / 2, h * 0.71))
  } else {
    els.push(text('12', NUM, h * 0.08, w / 2, h * 0.14))
    els.push(divider(w / 2, h * 0.24, w * 0.64, spec.divThick, false))
    els.push(text('عائلة', AR, h * 0.055, w / 2, h * 0.42))
    els.push(text('الدرويش', AR, h * 0.055, w / 2, h * 0.52))
  }
  return makeDesign(specName(spec), sign, els)
}

export const isNumberLine = (s: string) => /^[0-9٠-٩۰-۹\s\/\-.]+$/.test(s.trim())

/**
 * Sign Bot: build elements from raw text lines. groups[0] is the primary side
 * (right column / top), groups[1] the secondary. Rough positions only - the
 * arrange engine makes them perfect right after.
 */
export function botElements(spec: TemplateSpec, groups: string[][]): El[] {
  const { w, h } = spec
  const els: El[] = []
  const fontFor = (line: string) => (isNumberLine(line) ? NUM : AR)
  const clean = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean)
  const g0 = clean(groups[0] ?? [])
  const g1 = clean(groups[1] ?? [])

  const stack = (lines: string[], cx: number, top: number, bottom: number) => {
    const n = lines.length
    lines.forEach((line, i) => {
      const y = top + ((i + 0.5) / Math.max(1, n)) * (bottom - top)
      // numbers read bigger than names on real Mawguud signs (~1.6:1)
      els.push(text(line, fontFor(line), isNumberLine(line) ? h * 0.16 : h * 0.1, cx, y))
    })
  }

  if (spec.layout === 'leftright') {
    els.push(divider(w / 2, h / 2, h * 0.64, spec.divThick, true))
    stack(g0, w * 0.75, h * 0.2, h * 0.8) // right column (primary in Arabic)
    stack(g1, w * 0.25, h * 0.2, h * 0.8)
  } else {
    const tall = h > w
    const divY = tall ? h * 0.32 : h / 2
    stack(g0, w / 2, h * 0.06, divY - h * 0.04)
    els.push(divider(w / 2, divY, w * (tall ? 0.64 : 0.66), spec.divThick, false))
    stack(g1, w / 2, divY + h * 0.04, h * 0.94)
  }
  return els
}

export function makeBlank(): Design {
  return makeDesign('New sign', {
    w: 300,
    h: 150,
    radius: 0,
    bolts: true,
    boltDia: 6.5,
    boltInsetX: 15.3,
    boltInsetY: 75,
    boltPattern: 'sides',
  }, [text('موجود', AR, 55, 150, 70)])
}
