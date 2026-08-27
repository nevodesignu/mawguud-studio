// Bridge placement: every enclosed hole in a cut shape gets one bridge (a small
// uncut tab) so the counter does not fall out of the panel when the laser cuts.
// Candidates are sampled around the hole; we take the shortest crossing that does
// not collide with an already-placed bridge and does not pass through another hole.
import type { Pt, Ring, Poly, MultiPoly } from './types'
import { ringArea, ringCentroid, ringInterpolate, ringLength, nearestOnRing } from './poly'
import { subtract, intersects } from './weld'

export interface BridgeSettings {
  width: number // mm
  overshoot: number // mm past each wall so the tab fully crosses the stroke
  clearance: number // mm min distance between bridges
  minHoleArea: number // mm^2 - holes smaller than this are reported, not bridged
  candidates: number
}

export const defaultBridgeSettings: BridgeSettings = {
  width: 1.2,
  overshoot: 1.0,
  clearance: 1.5,
  minHoleArea: 3.0,
  candidates: 48,
}

export interface Bridge {
  key: string // stable per hole (relative centroid), used for manual overrides
  rect: Ring
  a: Pt // point on the hole ring
  b: Pt // point on the exterior ring
  span: number // stroke thickness crossed, mm
  t: number // arc-length parameter of `a` on its hole ring
  holeRing: Ring
  manual: boolean
}

export interface BridgeOutcome {
  geometry: MultiPoly // shape with bridge notches subtracted
  bridges: Bridge[]
  warnings: string[]
  tinyHoles: { center: Pt; area: number }[]
}

function bridgeRect(a: Pt, b: Pt, width: number, overshoot: number): Ring {
  let ux = b[0] - a[0]
  let uy = b[1] - a[1]
  const d = Math.hypot(ux, uy)
  if (d < 1e-9) {
    ux = 0
    uy = 1
  } else {
    ux /= d
    uy /= d
  }
  const nx = -uy
  const ny = ux
  const w2 = width / 2
  const A: Pt = [a[0] - ux * overshoot, a[1] - uy * overshoot]
  const B: Pt = [b[0] + ux * overshoot, b[1] + uy * overshoot]
  return [
    [A[0] + nx * w2, A[1] + ny * w2],
    [B[0] + nx * w2, B[1] + ny * w2],
    [B[0] - nx * w2, B[1] - ny * w2],
    [A[0] - nx * w2, A[1] - ny * w2],
  ]
}

/** Stable hole key: centroid relative to the shape's own bbox, rounded to 0.5mm. */
function holeKey(elId: string, hole: Ring, originX: number, originY: number): string {
  const [cx, cy] = ringCentroid(hole)
  const rx = Math.round((cx - originX) * 2) / 2
  const ry = Math.round((cy - originY) * 2) / 2
  return `${elId}|${rx},${ry}`
}

export function addBridges(
  mp: MultiPoly,
  elId: string,
  settings: BridgeSettings,
  overrides: Record<string, number>,
): BridgeOutcome {
  const warnings: string[] = []
  const tinyHoles: { center: Pt; area: number }[] = []
  const outGeometry: MultiPoly = []
  const allBridges: Bridge[] = []

  for (const poly of mp) {
    let current: MultiPoly = [poly]
    const exterior = poly[0]
    const holes = poly.slice(1)
    // key holes relative to their own welded island so overrides survive moving
    // other elements, and moving the island itself keeps them too
    let originX = Infinity
    let originY = Infinity
    for (const [x, y] of exterior ?? []) {
      if (x < originX) originX = x
      if (y < originY) originY = y
    }
    if (!isFinite(originX)) continue

    const big = holes
      .filter((h) => {
        const a = ringArea(h)
        if (a < settings.minHoleArea) {
          if (a > 0.2) tinyHoles.push({ center: ringCentroid(h), area: a })
          return false
        }
        return true
      })
      .sort((h1, h2) => ringArea(h2) - ringArea(h1))

    const placedRects: Ring[] = []
    const otherHolePolys = (skip: Ring) => big.filter((h) => h !== skip).map((h) => [h] as Poly)

    for (const hole of big) {
      const key = holeKey(elId, hole, originX, originY)
      const overrideT = overrides[key]
      let chosen: Bridge | null = null

      if (overrideT !== undefined) {
        const a = ringInterpolate(hole, overrideT)
        const near = nearestOnRing(exterior, a)
        chosen = {
          key,
          rect: bridgeRect(a, near.pt, settings.width, settings.overshoot),
          a,
          b: near.pt,
          span: near.dist,
          t: overrideT,
          holeRing: hole,
          manual: true,
        }
      } else {
        const n = settings.candidates
        const cands: { d: number; a: Pt; b: Pt; t: number }[] = []
        for (let i = 0; i < n; i++) {
          const t = i / n
          const a = ringInterpolate(hole, t)
          const near = nearestOnRing(exterior, a)
          cands.push({ d: near.dist, a, b: near.pt, t })
        }
        cands.sort((c1, c2) => c1.d - c2.d)
        for (const cand of cands) {
          const rect = bridgeRect(cand.a, cand.b, settings.width + settings.clearance * 2, settings.overshoot + settings.clearance)
          if (placedRects.some((r) => intersects([[rect]], [[r]]))) continue
          if (otherHolePolys(hole).some((hp) => intersects([[rect]], [hp]))) continue
          chosen = {
            key,
            rect: bridgeRect(cand.a, cand.b, settings.width, settings.overshoot),
            a: cand.a,
            b: cand.b,
            span: cand.d,
            t: cand.t,
            holeRing: hole,
            manual: false,
          }
          break
        }
        if (!chosen && cands.length) {
          const c0 = cands[0]
          chosen = {
            key,
            rect: bridgeRect(c0.a, c0.b, settings.width, settings.overshoot),
            a: c0.a,
            b: c0.b,
            span: c0.d,
            t: c0.t,
            holeRing: hole,
            manual: false,
          }
          warnings.push('One bridge could not avoid its neighbours - check it visually.')
        }
      }

      if (chosen) {
        placedRects.push(chosen.rect)
        allBridges.push(chosen)
        if (chosen.span > 8) {
          warnings.push(`A bridge crosses ${chosen.span.toFixed(1)}mm of material - long bridges are fragile.`)
        }
      }
    }

    current = subtract(current, placedRects.map((r) => [r]))

    // verify: no significant holes should remain
    for (const p of current) {
      for (const h of p.slice(1)) {
        if (ringArea(h) >= settings.minHoleArea) {
          warnings.push('A hole is still enclosed after bridging - move its bridge or add one manually.')
        }
      }
    }
    outGeometry.push(...current)
  }

  for (const th of tinyHoles) {
    warnings.push(
      `Tiny enclosed hole (${th.area.toFixed(1)}mm²) - too small to bridge; that piece will fall out when cut. Consider a larger size or different font.`,
    )
  }

  return { geometry: outGeometry, bridges: allBridges, warnings, tinyHoles }
}
