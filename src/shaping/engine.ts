// HarfBuzz shaping engine. Environment-agnostic: the caller supplies the wasm
// binary (browser fetches it via ?url, the smoke test reads it from node_modules).
// @ts-expect-error hbjs ships without type declarations
import hbjs from 'harfbuzzjs/hbjs.js'
// @ts-expect-error emscripten loader ships without type declarations
import createHarfBuzz from 'harfbuzzjs/hb.js'
import { parsePath, flattenCmds, type PathCmd } from '../geom/path'
import { glyphRingsToPoly, weld } from '../geom/weld'
import type { MultiPoly, BBox } from '../geom/types'
import { emptyBBox, growBBox } from '../geom/types'

type HB = ReturnType<typeof hbjs>

let hb: HB | null = null

export async function initHB(wasmBinary: ArrayBuffer | Uint8Array): Promise<void> {
  if (hb) return
  // hb.js is the package's own emscripten loader; handing it the wasm bytes
  // directly works identically in the browser (Vite ?url fetch) and in node.
  const bytes = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary)
  const module = await createHarfBuzz({ wasmBinary: bytes })
  hb = hbjs(module)
}

export const hbReady = () => hb !== null

export interface LoadedFont {
  id: string
  upem: number
  shapeRun(text: string, rtl: boolean): { g: number; ax: number; dx: number; dy: number; cl: number }[]
  glyphCmds(gid: number): PathCmd[]
  destroy(): void
}

export function loadFont(id: string, data: ArrayBuffer): LoadedFont {
  if (!hb) throw new Error('HarfBuzz not initialised')
  const engine = hb
  const blob = engine.createBlob(new Uint8Array(data))
  const face = engine.createFace(blob, 0)
  const font = engine.createFont(face)
  const upem: number = face.upem || 1000
  font.setScale(upem, upem)
  const pathCache = new Map<number, PathCmd[]>()

  return {
    id,
    upem,
    shapeRun(text, rtl) {
      const buf = engine.createBuffer()
      buf.addText(text)
      buf.guessSegmentProperties()
      buf.setDirection(rtl ? 'rtl' : 'ltr')
      engine.shape(font, buf)
      const arr = buf.json() as { g: number; ax: number; ay: number; dx: number; dy: number; cl: number }[]
      buf.destroy()
      return arr
    },
    glyphCmds(gid) {
      let cmds = pathCache.get(gid)
      if (!cmds) {
        cmds = parsePath(font.glyphToPath(gid))
        pathCache.set(gid, cmds)
      }
      return cmds
    },
    destroy() {
      font.destroy()
      face.destroy()
      blob.destroy()
    },
  }
}

// ---------- bidi-lite: split a single line into directional runs ----------
// Good enough for sign text: Arabic-block chars are R, Latin letters are L,
// digit groups render LTR, neutrals attach to their surroundings.

const isArabic = (ch: string) => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(ch)
const isLatin = (ch: string) => /[A-Za-zÀ-ɏḀ-ỿ]/.test(ch)
const isDigit = (ch: string) => /[0-9٠-٩۰-۹]/.test(ch)

export interface Run {
  text: string
  rtl: boolean
}

export function splitRuns(text: string): { runs: Run[]; paraRtl: boolean } {
  const chars = [...text]
  const classes = chars.map((ch) => (isArabic(ch) ? 'R' : isLatin(ch) ? 'L' : isDigit(ch) ? 'D' : 'N'))
  const firstStrong = classes.find((c) => c === 'R' || c === 'L')
  const paraRtl = firstStrong === 'R'

  // digits act as LTR blocks; resolve neutrals between equal classes to that class, else paragraph
  const resolved: string[] = classes.map((c) => (c === 'D' ? 'L' : c))
  for (let i = 0; i < resolved.length; i++) {
    if (resolved[i] !== 'N') continue
    let j = i
    while (j < resolved.length && resolved[j] === 'N') j++
    const before: string | undefined = i > 0 ? resolved[i - 1] : undefined
    const after: string | undefined = j < resolved.length ? resolved[j] : undefined
    const cls = before && before === after ? before : paraRtl ? 'R' : 'L'
    for (let k = i; k < j; k++) resolved[k] = cls
    i = j - 1
  }

  const runs: Run[] = []
  let start = 0
  for (let i = 1; i <= chars.length; i++) {
    if (i === chars.length || resolved[i] !== resolved[start]) {
      runs.push({ text: chars.slice(start, i).join(''), rtl: resolved[start] === 'R' })
      start = i
    }
  }
  if (paraRtl) runs.reverse()
  return { runs, paraRtl }
}

// ---------- shaped text ----------

export interface ShapedGlyph {
  cmds: PathCmd[]
  x: number // pen position in font units
  y: number
}

export interface ShapedText {
  glyphs: ShapedGlyph[]
  upem: number
  bbox: BBox // ink bbox in font units, y-up
  advance: number
}

/**
 * Shape a full line (handles mixed Arabic/Latin/digits).
 * letterSpacing (font units) is applied between glyphs of LTR runs and between runs —
 * never inside Arabic joins, which must stay connected.
 */
export function shapeLine(font: LoadedFont, text: string, letterSpacing = 0): ShapedText {
  const { runs } = splitRuns(text)
  const glyphs: ShapedGlyph[] = []
  let pen = 0
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    const shaped = font.shapeRun(run.text, run.rtl)
    for (let i = 0; i < shaped.length; i++) {
      const g = shaped[i]
      const cmds = font.glyphCmds(g.g)
      if (cmds.length) glyphs.push({ cmds, x: pen + g.dx, y: g.dy })
      pen += g.ax
      if (!run.rtl && letterSpacing !== 0 && i < shaped.length - 1) pen += letterSpacing
    }
    if (letterSpacing !== 0 && r < runs.length - 1) pen += letterSpacing
  }

  const bbox = emptyBBox()
  for (const g of glyphs) {
    for (const ring of flattenCmds(g.cmds, font.upem / 100)) {
      for (const [x, y] of ring) growBBox(bbox, x + g.x, y + g.y)
    }
  }
  return { glyphs, upem: font.upem, bbox, advance: pen }
}

/**
 * Convert shaped text to welded polygons in design space (mm, y-down).
 * scale = mm per font unit; (originX, originY) = design-space position of the pen origin (baseline left).
 * tolMm controls curve flattening accuracy in millimetres.
 */
export function shapedToPolys(shaped: ShapedText, scale: number, originX: number, originY: number, tolMm: number): MultiPoly {
  const tolUnits = Math.max(tolMm / scale, 0.01)
  const parts: MultiPoly[] = []
  for (const g of shaped.glyphs) {
    const rings = flattenCmds(g.cmds, tolUnits).map((ring) =>
      ring.map(([x, y]) => [originX + (x + g.x) * scale, originY - (y + g.y) * scale] as [number, number]),
    )
    const poly = glyphRingsToPoly(rings)
    if (poly.length) parts.push(poly)
  }
  return weld(parts)
}
