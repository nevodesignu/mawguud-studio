import { create } from 'zustand'
import type { Design, El, TextEl, SignSpec, FinalizeSettings, TemplateSpec } from '../model'
import { templateCatalog, makeFromSpec, makeBlank, makeDesign, normalizeDesign, uid, botElements, signFromSpec, specName } from '../model'
import { arrangeDesign } from '../layout/arrange'
import type { MultiPoly, Pt } from '../geom/types'
import { bboxOfMulti } from '../geom/types'
import type { Bridge } from '../geom/bridges'
import { addBridges } from '../geom/bridges'
import { shapedAsync } from '../shaping/service'
import { shapedToPolys } from '../shaping/engine'
import { barRing } from '../geom/poly'
import { weld, consumeGeometryErrors } from '../geom/weld'
import { saveDesign, listDesigns, loadDesignById, deleteDesignById, type DesignMeta } from './designsDb'
import type { FontMeta } from '../fonts/catalog'

export interface FinalizeResult {
  combinedRaw: MultiPoly // all elements welded together, BEFORE bridges
  geometry: MultiPoly // the true production shape: welded, bridged
  bridges: Bridge[]
  warnings: string[]
  tinyHoles: { center: Pt; area: number }[]
}

export type Mode = 'design' | 'finalize'

export type AlignOp = 'board-h' | 'board-v' | 'match-x' | 'match-y'

interface StudioState {
  design: Design
  designs: DesignMeta[]
  fonts: FontMeta[]
  selectedIds: string[]
  mode: Mode
  zoom: number
  panX: number
  panY: number
  shapeTick: number
  fin: FinalizeResult | null
  finalizing: boolean
  finError: string | null
  arranging: boolean
  outlineView: boolean
  saved: boolean
  toggleOutline(): void

  bumpShapeTick(): void
  setFonts(fonts: FontMeta[]): void
  select(id: string | null, additive?: boolean): void
  selectMany(ids: string[]): void
  selectAll(): void
  setView(zoom: number, panX: number, panY: number): void
  fitView(vw: number, vh: number): void

  mutate(fn: (d: Design) => void, opts?: { history?: boolean }): void
  beginGesture(): void
  endGesture(commit?: boolean): void
  undo(): void
  redo(): void

  updateEl(id: string, patch: Partial<El>): void
  addText(): void
  addDivider(): void
  removeEl(id: string): void
  duplicateEl(id: string): void
  setSign(patch: Partial<SignSpec>): void
  setFin(patch: Partial<FinalizeSettings>): void

  copySelected(): void
  cutSelected(): void
  paste(at?: { x: number; y: number }): void
  moveSelected(dx: number, dy: number): void
  removeSelected(): void
  duplicateSelected(): void
  alignSelected(op: AlignOp): void
  distributeSelectedV(): void
  setForSelectedTexts(patch: Partial<TextEl>): void
  autoArrange(): Promise<void>
  createFromBot(spec: TemplateSpec, groups: string[][]): Promise<void>

  setMode(mode: Mode): void
  runFinalize(): Promise<void>
  setBridgeOverride(key: string, t: number): void
  clearBridgeOverrides(): void

  flushSave(): Promise<void>
  refreshDesigns(): Promise<void>
  openDesign(id: string): Promise<void>
  newFromTemplate(spec: TemplateSpec): void
  newBlank(): void
  deleteDesign(id: string): Promise<void>
  duplicateDesign(): void
  setName(name: string): void
}

const clone = (d: Design): Design => JSON.parse(JSON.stringify(d))
const cloneEls = (els: El[]): El[] => JSON.parse(JSON.stringify(els))

export const hasClipboard = () => clipboard.length > 0

let past: Design[] = []
let future: Design[] = []
let gestureSnapshot: Design | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let finalizeToken = 0
// element clipboard - survives switching designs
let clipboard: El[] = []
let pasteN = 0

function pushHistory(snapshot: Design) {
  past.push(snapshot)
  if (past.length > 100) past.shift()
  future = []
}

function scheduleSave(get: () => StudioState, set: (p: Partial<StudioState>) => void) {
  set({ saved: false })
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void doSave(get, set), 600)
}

async function doSave(get: () => StudioState, set: (p: Partial<StudioState>) => void) {
  saveTimer = null
  const d = get().design
  d.updatedAt = Date.now()
  await saveDesign(d)
  set({ saved: true })
  void get().refreshDesigns()
}

const elLabel = (el: El) => (el.kind === 'text' ? `"${el.text.slice(0, 14)}"` : 'divider')

async function rawGeometryOf(el: El): Promise<MultiPoly> {
  if (el.kind === 'divider') {
    return [[barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)]]
  }
  const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
  const inkH = shaped.bbox.maxY - shaped.bbox.minY
  if (!(inkH > 0)) return []
  const s = el.heightMm / (shaped.refHeight > 0 ? shaped.refHeight : inkH)
  const cx = (shaped.bbox.minX + shaped.bbox.maxX) / 2
  const cy = (shaped.bbox.minY + shaped.bbox.maxY) / 2
  return shapedToPolys(shaped, s, el.x - cx * s, el.y + cy * s, 0.03)
}

function bridgeSettingsOf(design: Design) {
  return {
    width: design.fin.bridgeWidth,
    overshoot: 1,
    clearance: design.fin.clearance,
    minHoleArea: design.fin.minHoleArea,
    candidates: 48,
  }
}

function startFresh(set: (p: Partial<StudioState>) => void, d: Design) {
  past = []
  future = []
  gestureSnapshot = null
  set({ design: d, selectedIds: [], mode: 'design', fin: null, finError: null })
}

export const useStudio = create<StudioState>((set, get) => ({
  design: makeFromSpec(templateCatalog[0]),
  designs: [],
  fonts: [],
  selectedIds: [],
  mode: 'design',
  zoom: 1.6,
  panX: 60,
  panY: 60,
  shapeTick: 0,
  fin: null,
  finalizing: false,
  finError: null,
  arranging: false,
  outlineView: false,
  saved: true,
  toggleOutline: () => set((s) => ({ outlineView: !s.outlineView })),

  bumpShapeTick: () => set((s) => ({ shapeTick: s.shapeTick + 1 })),
  setFonts: (fonts) => set({ fonts }),
  select: (id, additive = false) => {
    if (id === null) {
      set({ selectedIds: [] })
      return
    }
    if (additive) {
      const cur = get().selectedIds
      set({ selectedIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
    } else {
      set({ selectedIds: [id] })
    }
  },
  selectMany: (ids) => set({ selectedIds: ids }),
  selectAll: () => set({ selectedIds: get().design.elements.map((e) => e.id) }),
  setView: (zoom, panX, panY) => set({ zoom, panX, panY }),
  fitView: (vw, vh) => {
    const { design } = get()
    const zoom = Math.min((vw - 120) / design.sign.w, (vh - 120) / design.sign.h)
    set({ zoom, panX: (vw - design.sign.w * zoom) / 2, panY: (vh - design.sign.h * zoom) / 2 })
  },

  mutate: (fn, opts = {}) => {
    const { history = true } = opts
    const before = get().design
    const d = clone(before)
    fn(d)
    if (history && !gestureSnapshot) pushHistory(clone(before))
    set({ design: d })
    scheduleSave(get, set)
    if (get().mode === 'finalize') void get().runFinalize()
  },
  beginGesture: () => {
    // self-heal: a dangling snapshot (a drag whose pointerup never arrived)
    // must not silently block history forever - commit it and move on
    if (gestureSnapshot) pushHistory(gestureSnapshot)
    gestureSnapshot = clone(get().design)
  },
  endGesture: (commit = true) => {
    if (gestureSnapshot) {
      if (commit) {
        pushHistory(gestureSnapshot)
        scheduleSave(get, set)
      }
      gestureSnapshot = null
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
        fontId: get().fonts.find((f) => f.id === 'avenir-arabic-medium')?.id ?? get().fonts[0]?.id ?? 'avenir-arabic-medium',
        heightMm: 30,
        x: d.sign.w / 2,
        y: d.sign.h / 2,
        spacingEm: 0,
      }
      d.elements.push(el)
      set({ selectedIds: [el.id] })
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
      set({ selectedIds: [el.id] })
    }),
  removeEl: (id) => {
    get().mutate((d) => {
      d.elements = d.elements.filter((e) => e.id !== id)
    })
    set({ selectedIds: get().selectedIds.filter((x) => x !== id) })
  },
  duplicateEl: (id) =>
    get().mutate((d) => {
      const el = d.elements.find((e) => e.id === id)
      if (!el) return
      const copy = { ...JSON.parse(JSON.stringify(el)), id: uid(), x: el.x + 10, y: el.y + 10 }
      d.elements.push(copy)
      set({ selectedIds: [copy.id] })
    }),
  setSign: (patch) =>
    get().mutate((d) => {
      Object.assign(d.sign, patch)
    }),
  setFin: (patch) =>
    get().mutate((d) => {
      Object.assign(d.fin, patch)
    }),

  copySelected: () => {
    const { design, selectedIds } = get()
    const els = design.elements.filter((e) => selectedIds.includes(e.id))
    if (els.length) {
      clipboard = cloneEls(els)
      pasteN = 0
    }
  },
  cutSelected: () => {
    get().copySelected()
    get().removeSelected()
  },
  paste: (at) => {
    if (!clipboard.length) return
    let dx: number
    let dy: number
    if (at) {
      // paste centered on the given point (context-menu "Paste here")
      const cx = clipboard.reduce((a, el) => a + el.x, 0) / clipboard.length
      const cy = clipboard.reduce((a, el) => a + el.y, 0) / clipboard.length
      dx = at.x - cx
      dy = at.y - cy
    } else {
      pasteN++
      dx = 8 * pasteN
      dy = 8 * pasteN
    }
    const ids: string[] = []
    get().mutate((d) => {
      for (const el of cloneEls(clipboard)) {
        el.id = uid()
        el.x = Math.round((el.x + dx) * 10) / 10
        el.y = Math.round((el.y + dy) * 10) / 10
        ids.push(el.id)
        d.elements.push(el)
      }
    })
    set({ selectedIds: ids })
  },
  moveSelected: (dx, dy) => {
    const ids = get().selectedIds
    if (!ids.length) return
    get().mutate((d) => {
      for (const el of d.elements) {
        if (ids.includes(el.id)) {
          el.x = Math.round((el.x + dx) * 10) / 10
          el.y = Math.round((el.y + dy) * 10) / 10
        }
      }
    })
  },
  removeSelected: () => {
    const ids = get().selectedIds
    if (!ids.length) return
    get().mutate((d) => {
      d.elements = d.elements.filter((e) => !ids.includes(e.id))
    })
    set({ selectedIds: [] })
  },
  duplicateSelected: () => {
    const ids = get().selectedIds
    if (!ids.length) return
    const newIds: string[] = []
    get().mutate((d) => {
      const copies = cloneEls(d.elements.filter((e) => ids.includes(e.id)))
      for (const el of copies) {
        el.id = uid()
        el.x += 10
        el.y += 10
        newIds.push(el.id)
        d.elements.push(el)
      }
    })
    set({ selectedIds: newIds })
  },
  alignSelected: (op) => {
    const { selectedIds, design } = get()
    if (!selectedIds.length) return
    const sel = design.elements.filter((e) => selectedIds.includes(e.id))
    const avg = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / vals.length
    const targetX = op === 'board-h' ? design.sign.w / 2 : avg(sel.map((e) => e.x))
    const targetY = op === 'board-v' ? design.sign.h / 2 : avg(sel.map((e) => e.y))
    get().mutate((d) => {
      for (const el of d.elements) {
        if (!selectedIds.includes(el.id)) continue
        if (op === 'board-h' || op === 'match-x') el.x = Math.round(targetX * 10) / 10
        if (op === 'board-v' || op === 'match-y') el.y = Math.round(targetY * 10) / 10
      }
    })
  },
  distributeSelectedV: () => {
    const { selectedIds, design } = get()
    const sel = design.elements.filter((e) => selectedIds.includes(e.id)).sort((a, b) => a.y - b.y)
    if (sel.length < 3) return
    const top = sel[0].y
    const step = (sel[sel.length - 1].y - top) / (sel.length - 1)
    const targets = new Map(sel.map((e, i) => [e.id, top + step * i]))
    get().mutate((d) => {
      for (const el of d.elements) {
        const t = targets.get(el.id)
        if (t !== undefined) el.y = Math.round(t * 10) / 10
      }
    })
  },
  setForSelectedTexts: (patch) => {
    const ids = get().selectedIds
    get().mutate((d) => {
      for (const el of d.elements) {
        if (el.kind === 'text' && ids.includes(el.id)) Object.assign(el, patch)
      }
    })
  },
  autoArrange: async () => {
    set({ arranging: true })
    try {
      const patches = await arrangeDesign(get().design)
      get().mutate((d) => {
        for (const el of d.elements) {
          const p = patches[el.id]
          if (p) Object.assign(el, p)
        }
      })
    } catch (err) {
      console.error('arrange failed', err)
    } finally {
      set({ arranging: false })
    }
  },
  createFromBot: async (spec, groups) => {
    await get().flushSave()
    startFresh(set, makeDesign(specName(spec), signFromSpec(spec), botElements(spec, groups)))
    await get().autoArrange()
    scheduleSave(get, set)
  },

  setMode: (mode) => {
    set({ mode })
    if (mode === 'finalize') void get().runFinalize()
  },

  runFinalize: async () => {
    const token = ++finalizeToken
    set({ finalizing: true })
    const { design } = get()
    const warnings: string[] = []
    // catch stealth duplicates (an accidental Ctrl+V lands 8mm away and hides
    // under the original) before they end up doubled in the cut file
    const textEls = design.elements.filter((e): e is TextEl => e.kind === 'text')
    for (let i = 0; i < textEls.length; i++) {
      for (let j = i + 1; j < textEls.length; j++) {
        const a = textEls[i]
        const b = textEls[j]
        if (a.text.trim() && a.text === b.text && a.fontId === b.fontId && Math.hypot(a.x - b.x, a.y - b.y) < Math.max(12, a.heightMm)) {
          warnings.push(`"${a.text.slice(0, 16)}" exists twice almost in the same spot - looks like an accidental duplicate. Delete one before cutting.`)
        }
      }
    }
    try {
      const raws: MultiPoly[] = []
      for (const el of design.elements) {
        try {
          raws.push(await rawGeometryOf(el))
        } catch (err) {
          console.error('element failed', el, err)
          warnings.push(`Element ${elLabel(el)} could not be processed - is its font still installed?`)
        }
      }
      if (token !== finalizeToken) return

      // Weld EVERYTHING first, THEN bridge: bridging per element and welding
      // afterwards can seal bridge tabs shut or create brand-new unbridged
      // holes wherever elements touch.
      const combinedRaw = weld(raws)
      const outcome = addBridges(combinedRaw, 'doc', bridgeSettingsOf(design), design.bridgeOverrides)
      warnings.push(...outcome.warnings, ...consumeGeometryErrors())

      const bb = bboxOfMulti(outcome.geometry)
      if (outcome.geometry.length && (bb.minX < -0.05 || bb.minY < -0.05 || bb.maxX > design.sign.w + 0.05 || bb.maxY > design.sign.h + 0.05)) {
        warnings.push('Artwork extends outside the board - move or shrink it before cutting.')
      }

      if (token !== finalizeToken) return
      set({
        fin: { combinedRaw, geometry: outcome.geometry, bridges: outcome.bridges, warnings, tinyHoles: outcome.tinyHoles },
        finalizing: false,
        finError: null,
      })
    } catch (err) {
      console.error('finalize failed', err)
      if (token === finalizeToken) {
        set({ fin: null, finalizing: false, finError: 'Finalize failed - fix the design (or re-add the missing font) and try again.' })
      }
    }
  },

  setBridgeOverride: (key, t) => {
    // live path while dragging a bridge; history is handled by the drag gesture
    const { design, fin } = get()
    if (!fin) return
    const nextDesign: Design = { ...design, bridgeOverrides: { ...design.bridgeOverrides, [key]: t } }
    const outcome = addBridges(fin.combinedRaw, 'doc', bridgeSettingsOf(nextDesign), nextDesign.bridgeOverrides)
    set({
      design: nextDesign,
      fin: { ...fin, geometry: outcome.geometry, bridges: outcome.bridges, warnings: [...outcome.warnings, ...consumeGeometryErrors()], tinyHoles: outcome.tinyHoles },
    })
    scheduleSave(get, set)
  },
  clearBridgeOverrides: () =>
    get().mutate((d) => {
      d.bridgeOverrides = {}
    }),

  flushSave: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      await doSave(get, set)
    }
  },
  refreshDesigns: async () => {
    set({ designs: await listDesigns() })
  },
  openDesign: async (id) => {
    await get().flushSave()
    const d = await loadDesignById(id)
    if (!d) return
    startFresh(set, normalizeDesign(d))
    set({ saved: true })
  },
  newFromTemplate: (spec) => {
    void get().flushSave()
    startFresh(set, makeFromSpec(spec))
    scheduleSave(get, set)
  },
  newBlank: () => {
    void get().flushSave()
    startFresh(set, makeBlank())
    scheduleSave(get, set)
  },
  deleteDesign: async (id) => {
    if (id === get().design.id) {
      // deleting the open design: drop its pending autosave so it stays deleted,
      // and move the editor to a fresh blank
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      await deleteDesignById(id)
      startFresh(set, makeBlank())
      set({ saved: true })
    } else {
      await deleteDesignById(id)
    }
    await get().refreshDesigns()
  },
  duplicateDesign: () => {
    void get().flushSave()
    const d = clone(get().design)
    d.id = uid()
    d.name = d.name + ' copy'
    past = []
    future = []
    gestureSnapshot = null
    set({ design: d, fin: null, finError: null, mode: 'design' })
    scheduleSave(get, set)
  },
  setName: (name) =>
    get().mutate((d) => {
      d.name = name
    }),
}))
