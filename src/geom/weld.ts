// Boolean operations: per-glyph even-odd resolution, then welding across glyphs.
import pc from 'polygon-clipping'
import type { Ring, MultiPoly } from './types'

type PcMulti = [number, number][][][]

/** Resolve one glyph's raw contours (mixed winding) into a proper polygon set via even-odd XOR. */
export function glyphRingsToPoly(rings: Ring[]): MultiPoly {
  const usable = rings.filter((r) => r.length >= 3)
  if (usable.length === 0) return []
  try {
    if (usable.length === 1) return pc.union([usable[0]] as never) as MultiPoly
    const [first, ...rest] = usable
    return pc.xor([first] as never, ...rest.map((r) => [r] as never)) as MultiPoly
  } catch {
    // degenerate contour data - fall back to treating every ring as filled
    try {
      return pc.union([usable[0]] as never, ...usable.slice(1).map((r) => [r] as never)) as MultiPoly
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
    return nonEmpty.flat().map((poly) => poly)
  }
}

export function subtract(subject: MultiPoly, clips: MultiPoly): MultiPoly {
  if (subject.length === 0) return []
  if (clips.length === 0) return subject
  try {
    return pc.difference(subject as PcMulti as never, clips as PcMulti as never) as MultiPoly
  } catch {
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
