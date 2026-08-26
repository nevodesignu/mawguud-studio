// Geometry primitives. All finalize/export geometry lives in DESIGN SPACE:
// millimetres, origin at the sign's top-left corner, y pointing DOWN (screen-like).
// Font-space geometry (from HarfBuzz) is y-up font units and gets transformed on the way in.

export type Pt = [number, number]
export type Ring = Pt[] // implicitly closed (last point != first point)
export type Poly = Ring[] // [exterior, ...holes]
export type MultiPoly = Poly[]

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const emptyBBox = (): BBox => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
})

export function growBBox(b: BBox, x: number, y: number): void {
  if (x < b.minX) b.minX = x
  if (y < b.minY) b.minY = y
  if (x > b.maxX) b.maxX = x
  if (y > b.maxY) b.maxY = y
}

export function bboxOfMulti(mp: MultiPoly): BBox {
  const b = emptyBBox()
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) growBBox(b, x, y)
  return b
}

export const bboxW = (b: BBox) => b.maxX - b.minX
export const bboxH = (b: BBox) => b.maxY - b.minY
