// Bridge placement: every enclosed hole in a cut shape gets one bridge (a small
// uncut tab) so the counter does not fall out of the panel when the laser cuts.
//
// Bridges must look DESIGNED, not computed (reference: Mawguud's hand-made
// production files):
//  - the cut crosses PERPENDICULAR to the letter edge, snapping to exactly
//    horizontal/vertical when the edge is close to axis-aligned
//  - the tab width scales with the stroke it crosses (a hairline sliver on a
//    big letter reads as a mistake; ~70% of the stroke reads as intentional)
//  - flat, straight parts of the edge are preferred over curves so the notch
//    gets clean square shoulders
import type { Pt, Ring, Poly, MultiPoly } from './types'
import { ringArea, ringCentroid, ringInterpolate, ringLength, nearestOnRing } from './poly'
import { subtract, intersects } from './weld'

export interface BridgeSettings {
  width: number // mm - minimum tab width; actual width scales with the stroke
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
  candidates: 64,
}

export interface Bridge {
  key: string // stable per hole (relative centroid), used for manual overrides
  rect: Ring
  a: Pt // point on the hole ring
  b: Pt // exit point on the exterior
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

const AXIS_SNAP = (20 * Math.PI) / 180 // snap the cut direction to h/v within 20°
const MAX_SPAN = 40 // give up on crossings thicker than this

function bridgeRect(a: Pt, dir: Pt, span: number, width: number, overshoot: number): Ring {
  const [ux, uy] = dir
  const nx = -uy
  const ny = ux
  const w2 = width / 2
  const A: Pt = [a[0] - ux * overshoot, a[1] - uy * overshoot]
  const B: Pt = [a[0] + ux * (span + overshoot), a[1] + uy * (span + overshoot)]
  return [
    [A[0] + nx * w2, A[1] + ny * w2],
    [B[0] + nx * w2, B[1] + ny * w2],
    [B[0] - nx * w2, B[1] - ny * w2],
    [A[0] - nx * w2, A[1] - ny * w2],
  ]
}

/** Distance along a ray to its nearest crossing of a ring, or null. */
function rayHit(origin: Pt, dir: Pt, ring: Ring): number | null {
  let best: number | null = null
  const [ox, oy] = origin
  const [dx, dy] = dir
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[(i + 1) % ring.length]
    const ex = bx - ax
    const ey = by - ay
    const denom = dx * ey - dy * ex
    if (Math.abs(denom) < 1e-12) continue
    const s = ((ax - ox) * ey - (ay - oy) * ex) / denom
    const u = ((ax - ox) * dy - (ay - oy) * dx) / denom
    if (u >= 0 && u <= 1 && s > 0.05) {
      if (best === null || s < best) best = s
    }
  }
  return best
}

interface EdgeProbe {
  p: Pt
  dir: Pt // unit direction of the cut, pointing from the hole into the material
  snapped: boolean
  flatness: number // 0 = straight edge here, larger = curving
}

/** Local outward normal of the hole edge at parameter t, axis-snapped when close. */
function probe(hole: Ring, t: number, centroid: Pt, halfWidth: number): EdgeProbe {
  const L = ringLength(hole)
  const step = Math.max(halfWidth, L * 0.01)
  const p = ringInterpolate(hole, t)
  const a = ringInterpolate(hole, (t - step / L + 1) % 1)
  const b = ringInterpolate(hole, (t + step / L) % 1)
  let tx = b[0] - a[0]
  let ty = b[1] - a[1]
  const tl = Math.hypot(tx, ty)
  if (tl < 1e-9) {
    tx = 1
    ty = 0
  } else {
    tx /= tl
    ty /= tl
  }
  let nx = -ty
  let ny = tx
  // outward = away from the hole's own centroid
  if (nx * (p[0] - centroid[0]) + ny * (p[1] - centroid[1]) < 0) {
    nx = -nx
    ny = -ny
  }
  // flatness: how far the mid point strays from the chord a-b
  const chordLen = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dev = chordLen > 1e-9 ? Math.abs((p[0] - a[0]) * ty - (p[1] - a[1]) * tx) : 0
  // snap to horizontal / vertical when the normal is nearly axis-aligned
  const ang = Math.atan2(ny, nx)
  const snapTargets = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI]
  let snapped = false
  for (const target of snapTargets) {
    let d = ang - target
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    if (Math.abs(d) < AXIS_SNAP) {
      nx = Math.round(Math.cos(target))
      ny = Math.round(Math.sin(target))
      snapped = true
      break
    }
  }
  return { p, dir: [nx, ny], snapped, flatness: dev / Math.max(1, chordLen) }
}

/** Unit tangent of the ring at its point nearest to `p`. */
function tangentNear(ring: Ring, p: Pt): Pt {
  const near = nearestOnRing(ring, p)
  const L = ringLength(ring)
  const eps = Math.max(0.4, L * 0.002) / L
  const a = ringInterpolate(ring, (near.t - eps + 1) % 1)
  const b = ringInterpolate(ring, (near.t + eps) % 1)
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = Math.hypot(dx, dy)
  return l > 1e-9 ? [dx / l, dy / l] : [1, 0]
}

/** Direction change (radians) of the ring across a window centred on t. */
function turnAt(ring: Ring, t: number, winMm: number): number {
  const L = ringLength(ring)
  const d = Math.min(0.2, winMm / L)
  const a = ringInterpolate(ring, (t - d + 1) % 1)
  const m = ringInterpolate(ring, t)
  const b = ringInterpolate(ring, (t + d) % 1)
  const v1: Pt = [m[0] - a[0], m[1] - a[1]]
  const v2: Pt = [b[0] - m[0], b[1] - m[1]]
  const l1 = Math.hypot(v1[0], v1[1])
  const l2 = Math.hypot(v2[0], v2[1])
  if (l1 < 1e-9 || l2 < 1e-9) return 0
  const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))
  return Math.acos(cos)
}

/** All sharp-corner points of a ring: spots where the outline's turn is
 * CONCENTRATED (a stroke junction, pinch or terminal), as opposed to a
 * smooth bowl whose turn is spread evenly. These are the places a bridge
 * must stay away from - measured euclidean, because a junction corner can
 * be millimetres across the material yet far away along the outline. */
function junctionPoints(ring: Ring): Pt[] {
  const L = ringLength(ring)
  const pts: Pt[] = []
  const steps = Math.max(16, Math.round(L))
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    const short = turnAt(ring, t, 1.0)
    const long = turnAt(ring, t, 2.6)
    if (short - long / 2 > 0.35) pts.push(ringInterpolate(ring, t))
  }
  return pts
}

/** Distance from point q to the segment a-b. */
function segDist(q: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / l2)) : 0
  return Math.hypot(q[0] - (a[0] + vx * t), q[1] - (a[1] + vy * t))
}

/**
 * Junction penalty (owner 2026-08-27: "stay away from intersection... it
 * gotta be clean"). A clean stroke has PARALLEL WALLS: the crossing width
 * barely changes just beside the tab, and the far wall runs parallel to the
 * near wall. Where strokes meet, the material widens into the joint, the
 * walls skew, and the outline CREASES at the pinch - all measurable, all
 * penalized.
 */
function junctionPenalty(hole: Ring, t: number, centroid: Pt, exterior: Ring, bridge: Bridge, settings: BridgeSettings, junctions: Pt[]): number {
  const L = ringLength(hole)
  const dT = Math.max(settings.width * 1.5, 2.5) / L
  let widen = 1
  for (const tt of [(t - dT + 1) % 1, (t + dT) % 1]) {
    const pr = probe(hole, tt, centroid, settings.width / 2)
    const s = rayHit(pr.p, pr.dir, exterior)
    const ratio = s === null ? 3 : Math.max(1, Math.min(3, s / Math.max(0.2, bridge.span)))
    widen = Math.max(widen, ratio)
  }
  const holeTan: Pt = tangentNear(hole, bridge.a)
  const extTan: Pt = tangentNear(exterior, bridge.b)
  const skew = Math.abs(holeTan[0] * extTan[1] - holeTan[1] * extTan[0]) // |sin| of wall angle
  let dJunction = Infinity
  for (const q of junctions) {
    const d = segDist(q, bridge.a, bridge.b)
    if (d < dJunction) dJunction = d
  }
  const corner = isFinite(dJunction) ? 3.2 / (1 + dJunction * dJunction * 0.55) : 0
  // the universal junction tell (works even when strokes merge with smooth
  // tangent joins, like a geometric 'a' bowl into its stem): the tab exits
  // into a narrow NOTCH - material sits right across a small air gap. A tab
  // on a clean stroke exits into open air.
  const dir: Pt = [(bridge.b[0] - bridge.a[0]) / bridge.span, (bridge.b[1] - bridge.a[1]) / bridge.span]
  const past: Pt = [bridge.b[0] + dir[0] * 0.11, bridge.b[1] + dir[1] * 0.11]
  const airGap = rayHit(past, dir, exterior)
  const notch = airGap !== null && airGap < 8 ? 2.6 / (1 + airGap * airGap * 0.3) : 0
  return 1 + Math.max(0, widen - 1.15) * 1.4 + skew * 1.2 + corner + notch
}

/** Tab width proportional to the stroke it crosses, floored at the user's setting. */
function tabWidth(span: number, settings: BridgeSettings): number {
  return Math.min(Math.max(settings.width, span * 0.7), Math.max(settings.width, 6))
}

/** Stable hole key: centroid relative to its own island's bbox, rounded to 0.5mm. */
function holeKey(elId: string, hole: Ring, originX: number, originY: number): string {
  const [cx, cy] = ringCentroid(hole)
  const rx = Math.round((cx - originX) * 2) / 2
  const ry = Math.round((cy - originY) * 2) / 2
  return `${elId}|${rx},${ry}`
}

function buildBridge(
  key: string,
  hole: Ring,
  t: number,
  centroid: Pt,
  exterior: Ring,
  otherHoles: Ring[],
  settings: BridgeSettings,
  manual: boolean,
): Bridge | null {
  const pr = probe(hole, t, centroid, settings.width / 2)
  let span = rayHit(pr.p, pr.dir, exterior)
  if (span === null || span > MAX_SPAN) {
    if (!manual) return null
    // manual placement must always produce something: fall back to nearest exit
    const near = nearestOnRing(exterior, pr.p)
    const d = Math.hypot(near.pt[0] - pr.p[0], near.pt[1] - pr.p[1])
    if (d < 1e-6) return null
    const dir: Pt = [(near.pt[0] - pr.p[0]) / d, (near.pt[1] - pr.p[1]) / d]
    const w = tabWidth(d, settings)
    return { key, rect: bridgeRect(pr.p, dir, d, w, settings.overshoot), a: pr.p, b: near.pt, span: d, t, holeRing: hole, manual }
  }
  if (!manual) {
    for (const other of otherHoles) {
      const h = rayHit(pr.p, pr.dir, other)
      if (h !== null && h < span) return null // would tunnel through another hole
    }
  }
  const w = tabWidth(span, settings)
  const b: Pt = [pr.p[0] + pr.dir[0] * span, pr.p[1] + pr.dir[1] * span]
  return { key, rect: bridgeRect(pr.p, pr.dir, span, w, settings.overshoot), a: pr.p, b, span, t, holeRing: hole, manual }
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
  // spans ALL islands: two identical letters in different islands produce the
  // same relative centroid, and duplicate keys break overrides and React keys
  const usedKeys = new Set<string>()

  for (const poly of mp) {
    let current: MultiPoly = [poly]
    const exterior = poly[0]
    const holes = poly.slice(1)
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
    // every sharp corner on this island - junctions a bridge must stay clear of
    const islandJunctions: Pt[] = junctionPoints(exterior)
    for (const hh of big) islandJunctions.push(...junctionPoints(hh))

    for (const hole of big) {
      let key = holeKey(elId, hole, originX, originY)
      while (usedKeys.has(key)) key += "'" // two holes can round to the same centroid
      usedKeys.add(key)
      const centroid = ringCentroid(hole)
      const otherHoles = big.filter((h) => h !== hole)
      const overrideT = overrides[key]
      let chosen: Bridge | null = null

      if (overrideT !== undefined) {
        chosen = buildBridge(key, hole, overrideT, centroid, exterior, otherHoles, settings, true)
      } else {
        const n = settings.candidates
        const cands: { score: number; bridge: Bridge }[] = []
        for (let i = 0; i < n; i++) {
          const bridge = buildBridge(key, hole, i / n, centroid, exterior, otherHoles, settings, false)
          if (!bridge) continue
          const pr = probe(hole, i / n, centroid, settings.width / 2)
          // short crossings first; axis-aligned cuts and flat edges look
          // designed; junctions (walls widening or skewing) look BROKEN
          const jp = junctionPenalty(hole, i / n, centroid, exterior, bridge, settings, islandJunctions)
          const score = bridge.span * (pr.snapped ? 1 : 1.3) * (1 + pr.flatness * 2) * jp
          if ((globalThis as { BRIDGE_DEBUG?: string }).BRIDGE_DEBUG === key) {
            console.log(`  t=${(i / n).toFixed(3)} a=(${bridge.a[0].toFixed(1)},${bridge.a[1].toFixed(1)}) span=${bridge.span.toFixed(2)} snap=${pr.snapped} flat=${pr.flatness.toFixed(2)} jp=${jp.toFixed(2)} score=${score.toFixed(2)}`)
          }
          cands.push({ score, bridge })
        }
        cands.sort((c1, c2) => c1.score - c2.score)
        for (const cand of cands) {
          const grown = bridgeRect(
            cand.bridge.a,
            [(cand.bridge.b[0] - cand.bridge.a[0]) / cand.bridge.span, (cand.bridge.b[1] - cand.bridge.a[1]) / cand.bridge.span],
            cand.bridge.span,
            tabWidth(cand.bridge.span, settings) + settings.clearance * 2,
            settings.overshoot + settings.clearance,
          )
          if (placedRects.some((r) => intersects([[grown]], [[r]]))) continue
          if (otherHoles.some((h) => intersects([[grown]], [[h]]))) continue
          chosen = cand.bridge
          break
        }
        if (!chosen && cands.length) {
          chosen = cands[0].bridge
          warnings.push('One bridge could not avoid its neighbours - check it visually.')
        }
      }

      if (chosen) {
        placedRects.push(chosen.rect)
        allBridges.push(chosen)
        // fragility is about proportions: a long tab is fine when it is wide too
        if (tabWidth(chosen.span, settings) / chosen.span < 0.2) {
          warnings.push(`A bridge is long and thin (${chosen.span.toFixed(1)}mm crossing) - it may snap; consider moving it to a thinner part.`)
        }
      }
    }

    current = subtract(current, placedRects.map((r) => [r]))

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
