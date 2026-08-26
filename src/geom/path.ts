// SVG-style path parsing + adaptive flattening.
// HarfBuzz (hbjs glyphToPath) emits absolute M/L/Q/C/Z commands in font units, y-up.

import type { Pt, Ring } from './types'

export interface PathCmd {
  c: 'M' | 'L' | 'Q' | 'C' | 'Z'
  pts: number[] // flat [x0,y0,x1,y1,...]
}

const NUM = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi

export function parsePath(d: string): PathCmd[] {
  const cmds: PathCmd[] = []
  const re = /([MLQCZmlqcz])([^MLQCZmlqcz]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const letter = m[1].toUpperCase() as PathCmd['c']
    const nums = (m[2].match(NUM) ?? []).map(Number)
    cmds.push({ c: letter, pts: nums })
  }
  return cmds
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function flattenQuad(out: Pt[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, tol: number, depth: number): void {
  if (depth > 16 || distToSeg(cx, cy, x0, y0, x1, y1) <= tol) {
    out.push([x1, y1])
    return
  }
  const ax = (x0 + cx) / 2
  const ay = (y0 + cy) / 2
  const bx = (cx + x1) / 2
  const by = (cy + y1) / 2
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  flattenQuad(out, x0, y0, ax, ay, mx, my, tol, depth + 1)
  flattenQuad(out, mx, my, bx, by, x1, y1, tol, depth + 1)
}

function flattenCubic(out: Pt[], x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x1: number, y1: number, tol: number, depth: number): void {
  const d = Math.max(distToSeg(c1x, c1y, x0, y0, x1, y1), distToSeg(c2x, c2y, x0, y0, x1, y1))
  if (depth > 16 || d <= tol) {
    out.push([x1, y1])
    return
  }
  const p01x = (x0 + c1x) / 2, p01y = (y0 + c1y) / 2
  const p12x = (c1x + c2x) / 2, p12y = (c1y + c2y) / 2
  const p23x = (c2x + x1) / 2, p23y = (c2y + y1) / 2
  const p012x = (p01x + p12x) / 2, p012y = (p01y + p12y) / 2
  const p123x = (p12x + p23x) / 2, p123y = (p12y + p23y) / 2
  const mx = (p012x + p123x) / 2, my = (p012y + p123y) / 2
  flattenCubic(out, x0, y0, p01x, p01y, p012x, p012y, mx, my, tol, depth + 1)
  flattenCubic(out, mx, my, p123x, p123y, p23x, p23y, x1, y1, tol, depth + 1)
}

/** Flatten parsed commands into closed rings. tol is max chord error, same units as input. */
export function flattenCmds(cmds: PathCmd[], tol: number): Ring[] {
  const rings: Ring[] = []
  let cur: Pt[] = []
  let cx = 0
  let cy = 0
  const close = () => {
    if (cur.length >= 3) rings.push(cur)
    cur = []
  }
  for (const cmd of cmds) {
    const p = cmd.pts
    switch (cmd.c) {
      case 'M':
        close()
        cx = p[0]
        cy = p[1]
        cur = [[cx, cy]]
        for (let i = 2; i + 1 < p.length; i += 2) {
          cx = p[i]
          cy = p[i + 1]
          cur.push([cx, cy])
        }
        break
      case 'L':
        for (let i = 0; i + 1 < p.length; i += 2) {
          cx = p[i]
          cy = p[i + 1]
          cur.push([cx, cy])
        }
        break
      case 'Q':
        for (let i = 0; i + 3 < p.length; i += 4) {
          flattenQuad(cur, cx, cy, p[i], p[i + 1], p[i + 2], p[i + 3], tol, 0)
          cx = p[i + 2]
          cy = p[i + 3]
        }
        break
      case 'C':
        for (let i = 0; i + 5 < p.length; i += 6) {
          flattenCubic(cur, cx, cy, p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], tol, 0)
          cx = p[i + 4]
          cy = p[i + 5]
        }
        break
      case 'Z':
        close()
        break
    }
  }
  close()
  return rings
}

/** Re-emit commands as an SVG d string with a translation applied (same units). */
export function cmdsToD(cmds: PathCmd[], dx: number, dy: number): string {
  const parts: string[] = []
  for (const cmd of cmds) {
    if (cmd.c === 'Z') {
      parts.push('Z')
      continue
    }
    const nums: string[] = []
    for (let i = 0; i + 1 < cmd.pts.length; i += 2) {
      nums.push(`${(cmd.pts[i] + dx).toFixed(1)} ${(cmd.pts[i + 1] + dy).toFixed(1)}`)
    }
    parts.push(cmd.c + nums.join(' '))
  }
  return parts.join('')
}
