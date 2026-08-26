import type { Pt, Ring, Poly, MultiPoly } from './types'

export function signedArea(ring: Ring): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

export const ringArea = (ring: Ring) => Math.abs(signedArea(ring))

export function ringCentroid(ring: Ring): Pt {
  let cx = 0
  let cy = 0
  for (const [x, y] of ring) {
    cx += x
    cy += y
  }
  return [cx / ring.length, cy / ring.length]
}

export function ringLength(ring: Ring): number {
  let len = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    len += Math.hypot(x2 - x1, y2 - y1)
  }
  return len
}

/** Point at parameter t (0..1 by arc length) along a closed ring. */
export function ringInterpolate(ring: Ring, t: number): Pt {
  const total = ringLength(ring)
  let target = ((t % 1) + 1) % 1 * total
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    const seg = Math.hypot(x2 - x1, y2 - y1)
    if (target <= seg && seg > 0) {
      const f = target / seg
      return [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f]
    }
    target -= seg
  }
  return ring[0]
}

/** Nearest point on a closed ring to p. Returns point, distance, and arc-length parameter t. */
export function nearestOnRing(ring: Ring, p: Pt): { pt: Pt; dist: number; t: number } {
  let best: Pt = ring[0]
  let bestDist = Infinity
  let bestLen = 0
  let walked = 0
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[(i + 1) % ring.length]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const seg = Math.sqrt(len2)
    let t = 0
    if (len2 > 1e-12) t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2))
    const qx = ax + t * dx
    const qy = ay + t * dy
    const d = Math.hypot(p[0] - qx, p[1] - qy)
    if (d < bestDist) {
      bestDist = d
      best = [qx, qy]
      bestLen = walked + t * seg
    }
    walked += seg
  }
  const total = ringLength(ring)
  return { pt: best, dist: bestDist, t: total > 0 ? bestLen / total : 0 }
}

export function translateMulti(mp: MultiPoly, dx: number, dy: number): MultiPoly {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as Pt)))
}

export function scaleMulti(mp: MultiPoly, sx: number, sy: number): MultiPoly {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x * sx, y * sy] as Pt)))
}

/** SVG path d for a MultiPoly (even-odd assumed by the consumer). */
export function multiToD(mp: MultiPoly, digits = 3): string {
  const parts: string[] = []
  for (const poly of mp) {
    for (const ring of poly) {
      if (ring.length < 3) continue
      parts.push(
        'M' +
          ring.map(([x, y]) => `${x.toFixed(digits)} ${y.toFixed(digits)}`).join('L') +
          'Z',
      )
    }
  }
  return parts.join('')
}

export function roundedRectRing(x: number, y: number, w: number, h: number, r: number, steps = 12): Ring {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  if (rr === 0) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]
  }
  const ring: Ring = []
  // corner centers in y-down space, arcs traced clockwise visually
  const corners: [number, number, number][] = [
    [x + rr, y + rr, 180],
    [x + w - rr, y + rr, 270],
    [x + w - rr, y + h - rr, 0],
    [x + rr, y + h - rr, 90],
  ]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = ((a0 + (90 * i) / steps) * Math.PI) / 180
      ring.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
    }
  }
  return ring
}

export function circleRing(cx: number, cy: number, r: number, steps = 48): Ring {
  const ring: Ring = []
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return ring
}

/** Capsule (line with round caps) or plain rectangle, as a single ring. */
export function barRing(cx: number, cy: number, length: number, thickness: number, vertical: boolean, roundCaps: boolean): Ring {
  const half = length / 2
  const t2 = thickness / 2
  const ux = vertical ? 0 : 1
  const uy = vertical ? 1 : 0
  const nx = -uy
  const ny = ux
  const a: Pt = [cx - ux * half, cy - uy * half]
  const b: Pt = [cx + ux * half, cy + uy * half]
  if (!roundCaps) {
    return [
      [a[0] + nx * t2, a[1] + ny * t2],
      [b[0] + nx * t2, b[1] + ny * t2],
      [b[0] - nx * t2, b[1] - ny * t2],
      [a[0] - nx * t2, a[1] - ny * t2],
    ]
  }
  const ring: Ring = []
  const baseA = Math.atan2(ny, nx)
  const steps = 16
  for (let i = 0; i <= steps; i++) {
    const ang = baseA + Math.PI * (i / steps)
    ring.push([a[0] + t2 * Math.cos(ang), a[1] + t2 * Math.sin(ang)])
  }
  for (let i = 0; i <= steps; i++) {
    const ang = baseA + Math.PI + Math.PI * (i / steps)
    ring.push([b[0] + t2 * Math.cos(ang), b[1] + t2 * Math.sin(ang)])
  }
  return ring
}
