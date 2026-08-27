// Boolean operations: per-glyph winding resolution, then welding across glyphs.
import pc from 'polygon-clipping'
import type { Ring, MultiPoly } from './types'
import { signedArea } from './poly'

type PcMulti = [number, number][][][]

// Boolean failures must never be silent: a wrong shape here becomes a ruined
// acrylic sheet. Failures are collected and surfaced as finalize warnings.
let geometryErrors: string[] = []
export function consumeGeometryErrors(): string[] {
  const out = geometryErrors
  geometryErrors = []
  return out
}

/**
 * Resolve one glyph's raw contours into a proper polygon set.
 * Fonts fill with the NONZERO winding rule: contours wound one way are solid,
 * opposite-wound contours are counters — and overlapping same-direction
 * contours (common in composite/instanced fonts) must UNION, not cancel.
 * We approximate nonzero by taking the dominant ring orientation as "solid":
 * union all solid rings, then subtract the union of counter rings.
 */
export function glyphRingsToPoly(rings: Ring[]): MultiPoly {
  const usable = rings.filter((r) => r.length >= 3)
  if (usable.length === 0) return []
  let outerSign = 1
  let best = 0
  for (const r of usable) {
    const a = signedArea(r)
    if (Math.abs(a) > best) {
      best = Math.abs(a)
      outerSign = Math.sign(a) || 1
    }
  }
  const solids = usable.filter((r) => Math.sign(signedArea(r)) === outerSign)
  const counters = usable.filter((r) => Math.sign(signedArea(r)) !== outerSign)
  try {
    const [s0, ...sRest] = solids
    const filled = pc.union([s0] as never, ...sRest.map((r) => [r] as never)) as MultiPoly
    if (counters.length === 0) return filled
    const [c0, ...cRest] = counters
    const holes = pc.union([c0] as never, ...cRest.map((r) => [r] as never)) as MultiPoly
    return pc.difference(filled as PcMulti as never, holes as PcMulti as never) as MultiPoly
  } catch (err) {
    geometryErrors.push('A letter shape could not be resolved cleanly - inspect it closely before cutting.')
    try {
      const [f0, ...fRest] = usable
      return pc.union([f0] as never, ...fRest.map((r) => [r] as never)) as MultiPoly
    } catch {
      return []
    }
  }
}

/** Weld many polygon sets into one (overlapping Arabic joins fuse together). */
export function weld(parts: MultiPoly[]): MultiPoly {
  const nonEmpty = parts.filter((p) => p.length > 0)
  if (nonEmpty.length === 0) return []
  if (nonEmpty.length === 1) return nonEmpty[0]
  try {
    const [first, ...rest] = nonEmpty
    return pc.union(first as PcMulti as never, ...rest.map((p) => p as PcMulti as never)) as MultiPoly
  } catch {
    geometryErrors.push('Welding shapes together failed - the exported file may have overlapping outlines.')
    return nonEmpty.flat().map((poly) => poly)
  }
}

export function subtract(subject: MultiPoly, clips: MultiPoly): MultiPoly {
  if (subject.length === 0) return []
  if (clips.length === 0) return subject
  try {
    return pc.difference(subject as PcMulti as never, clips as PcMulti as never) as MultiPoly
  } catch {
    geometryErrors.push('Cutting a bridge notch failed - verify every bridge visually.')
    return subject
  }
}

export function intersects(a: MultiPoly, b: MultiPoly): boolean {
  if (a.length === 0 || b.length === 0) return false
  try {
    return (pc.intersection(a as PcMulti as never, b as PcMulti as never) as MultiPoly).length > 0
  } catch {
    return true // be conservative: report a conflict if the check itself failed
  }
}
