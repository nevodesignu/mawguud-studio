import { create } from 'zustand'
import type { Design, El, TextEl, SignSpec, FinalizeSettings } from '../model'
import { templates, uid } from '../model'
import type { MultiPoly, Pt } from '../geom/types'
import type { Bridge } from '../geom/bridges'
import { addBridges } from '../geom/bridges'
import { shapedAsync } from '../shaping/service'
import { shapedToPolys } from '../shaping/engine'
import { barRing } from '../geom/poly'
import { saveDesign, listDesigns, loadDesignById, deleteDesignById, type DesignMeta } from './designsDb'
import type { FontMeta } from '../fonts/catalog'

export interface FinalizeElResult {
  id: string
  raw: MultiPoly // welded, pre-bridges
  geometry: MultiPoly // bridged
  bridges: Bridge[]
  warnings: string[]
  tinyHoles: { center: Pt; area: number }[]
}

export interface FinalizeResult {
  els: FinalizeElResult[]
  warnings: string[]
}

export type Mode = 'design' | 'finalize'

interface StudioState {
  design: Design
  designs: DesignMeta[]
  fonts: FontMeta[]
  selectedId: string | null
  mode: Mode
  zoom: number
  panX: number
  panY: number
  shapeTick: number
  fin: FinalizeResult | null
  finalizing: boolean
  saved: boolean

  bumpShapeTick(): void
  setFonts(fonts: FontMeta[]): void
  select(id: string | null): void
  setView(zoom: number, panX: number, panY: number): void
  fitView(vw: number, vh: number): void

  mutate(fn: (d: Design) => void, opts?: { history?: boolean }): void
  beginGesture(): void
  endGesture(): void
  undo(): void
  redo(): void

  updateEl(id: string, patch: Partial<El>): void
  addText(): void
  addDivider(): void
  removeEl(id: string): void
  duplicateEl(id: string): void
  setSign(patch: Partial<SignSpec>): void
  setFin(patch: Partial<FinalizeSettings>): void

  setMode(mode: Mode): void
  runFinalize(): Promise<void>
  setBridgeOverride(key: string, t: number, elId: string): void
  clearBridgeOverrides(): void

  refreshDesigns(): Promise<void>
  openDesign(id: string): Promise<void>
  newFromTemplate(tplId: string): void
  deleteDesign(id: string): Promise<void>
  duplicateDesign(): void
  setName(name: string): void
}

const clone = (d: Design): Design => JSON.parse(JSON.stringify(d))

let past: Design[] = []
let future: Design[] = []
let gestureSnapshot: Design | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let finalizeToken = 0

function scheduleSave(get: () => StudioState, set: (p: Partial<StudioState>) => void) {
  set({ saved: false })
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const d = get().design
    d.updatedAt = Date.now()
    await saveDesign(d)
    set({ saved: true })
    get().refreshDesigns()
  }, 600)
}

async function computeTextEl(el: TextEl, fin: FinalizeSettings, overrides: Record<string, number>): Promise<FinalizeElResult> {
  const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
  const inkH = shaped.bbox.maxY - shaped.bbox.minY
  if (!(inkH > 0)) {
    return { id: el.id, raw: [], geometry: [], bridges: [], warnings: [], tinyHoles: [] }
  }
  const s = el.heightMm / inkH
  const cx = (shaped.bbox.minX + shaped.bbox.maxX) / 2
  const cy = (shaped.bbox.minY + shaped.bbox.maxY) / 2
  const ox = el.x - cx * s
  const oy = el.y + cy * s
  const raw = shapedToPolys(shaped, s, ox, oy, 0.03)
  const outcome = addBridges(raw, el.id, { width: fin.bridgeWidth, overshoot: 1, clearance: fin.clearance, minHoleArea: fin.minHoleArea, candidates: 48 }, overrides)
  return { id: el.id, raw, geometry: outcome.geometry, bridges: outcome.bridges, warnings: outcome.warnings, tinyHoles: outcome.tinyHoles }
}

function computeDividerEl(el: Exclude<El, TextEl>): FinalizeElResult {
  const ring = barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)
  return { id: el.id, raw: [[ring]], geometry: [[ring]], bridges: [], warnings: [], tinyHoles: [] }
}

export const useStudio = create<StudioState>((set, get) => ({
  design: templates[0].make(),
  designs: [],
  fonts: [],
  selectedId: null,
  mode: 'design',
  zoom: 1.6,
  panX: 60,
  panY: 60,
  shapeTick: 0,
  fin: null,
  finalizing: false,
  saved: true,

  bumpShapeTick: () => set((s) => ({ shapeTick: s.shapeTick + 1 })),
  setFonts: (fonts) => set({ fonts }),
  select: (id) => set({ selectedId: id }),
  setView: (zoom, panX, panY) => set({ zoom, panX, panY }),
  fitView: (vw, vh) => {
    const { design } = get()
    const zoom = Math.min((vw - 120) / design.sign.w, (vh - 120) / design.sign.h)
    set({ zoom, panX: (vw - design.sign.w * zoom) / 2, panY: (vh - design.sign.h * zoom) / 2 })
  },

  mutate: (fn, opts = {}) => {
    const { history = true } = opts
    const d = clone(get().design)
    fn(d)
    if (history && !gestureSnapshot) {
      past.push(clone(get().design))
      if (past.length > 100) past.shift()
      future = []
    }
    set({ design: d })
    scheduleSave(get, set)
    if (get().mode === 'finalize') void get().runFinalize()
  },
  beginGesture: () => {
    gestureSnapshot = clone(get().design)
  },
  endGesture: () => {
    if (gestureSnapshot) {
      past.push(gestureSnapshot)
      if (past.length > 100) past.shift()
      future = []
      gestureSnapshot = null
      scheduleSave(get, set)
    }
  },
  undo: () => {
    const prev = past.pop()
    if (!prev) return
    future.push(clone(get().design))
    set({ design: prev })
    scheduleSave(get, set)
    if (get().mode === 'finalize') void get().runFinalize()
  },
  redo: () => {
    const next = future.pop()
    if (!next) return
    past.push(clone(get().design))
    set({ design: next })
    scheduleSave(get, set)
    if (get().mode === 'finalize') void get().runFinalize()
  },

  updateEl: (id, patch) =>
    get().mutate((d) => {
      const el = d.elements.find((e) => e.id === id)
      if (el) Object.assign(el, patch)
    }),
  addText: () =>
    get().mutate((d) => {
      const el: TextEl = {
        id: uid(),
        kind: 'text',
        text: 'نص جديد',
        fontId: get().fonts.find((f) => f.id === 'amiri-bold')?.id ?? get().fonts[0]?.id ?? 'amiri-bold',
        heightMm: 30,
        x: d.sign.w / 2,
        y: d.sign.h / 2,
        spacingEm: 0,
      }
      d.elements.push(el)
      set({ selectedId: el.id })
    }),
  addDivider: () =>
    get().mutate((d) => {
      const el: El = {
        id: uid(),
        kind: 'divider',
        x: d.sign.w / 2,
        y: d.sign.h / 2,
        length: Math.min(d.sign.w, d.sign.h) * 0.6,
        thickness: 1.2,
        vertical: false,
        roundCaps: false,
      }
      d.elements.push(el)
      set({ selectedId: el.id })
    }),
  removeEl: (id) => {
    get().mutate((d) => {
      d.elements = d.elements.filter((e) => e.id !== id)
    })
    if (get().selectedId === id) set({ selectedId: null })
  },
  duplicateEl: (id) =>
    get().mutate((d) => {
      const el = d.elements.find((e) => e.id === id)
      if (!el) return
      const copy = { ...JSON.parse(JSON.stringify(el)), id: uid(), x: el.x + 10, y: el.y + 10 }
      d.elements.push(copy)
      set({ selectedId: copy.id })
    }),
  setSign: (patch) =>
    get().mutate((d) => {
      Object.assign(d.sign, patch)
    }),
  setFin: (patch) =>
    get().mutate((d) => {
      Object.assign(d.fin, patch)
    }),

  setMode: (mode) => {
    set({ mode })
    if (mode === 'finalize') void get().runFinalize()
  },
  runFinalize: async () => {
    const token = ++finalizeToken
    set({ finalizing: true })
    const { design } = get()
    try {
      const els: FinalizeElResult[] = []
      for (const el of design.elements) {
        els.push(el.kind === 'text' ? await computeTextEl(el, design.fin, design.bridgeOverrides) : computeDividerEl(el))
      }
      if (token !== finalizeToken) return
      const warnings = els.flatMap((e) => e.warnings)
      set({ fin: { els, warnings }, finalizing: false })
    } catch (err) {
      console.error('finalize failed', err)
      if (token === finalizeToken) set({ finalizing: false })
    }
  },
  setBridgeOverride: (key, t, elId) => {
    // live path used while dragging a bridge: update override + recompute just that element
    const { design, fin } = get()
    design.bridgeOverrides[key] = t
    if (!fin) return
    const el = design.elements.find((e) => e.id === elId)
    const entry = fin.els.find((e) => e.id === elId)
    if (!el || !entry || el.kind !== 'text') return
    const outcome = addBridges(entry.raw, el.id, { width: design.fin.bridgeWidth, overshoot: 1, clearance: design.fin.clearance, minHoleArea: design.fin.minHoleArea, candidates: 48 }, design.bridgeOverrides)
    const els = fin.els.map((e) => (e.id === elId ? { ...e, geometry: outcome.geometry, bridges: outcome.bridges, warnings: outcome.warnings } : e))
    set({ fin: { els, warnings: els.flatMap((e) => e.warnings) }, design: { ...design } })
    scheduleSave(get, set)
  },
  clearBridgeOverrides: () =>
    get().mutate((d) => {
      d.bridgeOverrides = {}
    }),

  refreshDesigns: async () => {
    set({ designs: await listDesigns() })
  },
  openDesign: async (id) => {
    const d = await loadDesignById(id)
    if (!d) return
    past = []
    future = []
    set({ design: d, selectedId: null, mode: 'design', fin: null })
  },
  newFromTemplate: (tplId) => {
    const tpl = templates.find((t) => t.id === tplId)
    if (!tpl) return
    past = []
    future = []
    const d = tpl.make()
    set({ design: d, selectedId: null, mode: 'design', fin: null })
    scheduleSave(get, set)
  },
  deleteDesign: async (id) => {
    await deleteDesignById(id)
    await get().refreshDesigns()
  },
  duplicateDesign: () => {
    const d = clone(get().design)
    d.id = uid()
    d.name = d.name + ' copy'
    past = []
    future = []
    set({ design: d })
    scheduleSave(get, set)
  },
  setName: (name) =>
    get().mutate((d) => {
      d.name = name
    }),
}))
