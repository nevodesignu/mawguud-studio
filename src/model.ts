// Design document model. All dimensions in millimetres.

export interface SignSpec {
  w: number
  h: number
  radius: number
  mountHoles: boolean
  holeDia: number
  holeInset: number
}

export interface TextEl {
  id: string
  kind: 'text'
  text: string
  fontId: string
  heightMm: number // ink height of the rendered text
  x: number // centre of ink bbox
  y: number
  spacingEm: number // extra tracking, fraction of em (never applied inside Arabic joins)
}

export interface DividerEl {
  id: string
  kind: 'divider'
  x: number // centre
  y: number
  length: number
  thickness: number
  vertical: boolean
  roundCaps: boolean
}

export type El = TextEl | DividerEl

export interface FinalizeSettings {
  bridgeWidth: number
  clearance: number
  minHoleArea: number
}

export interface Design {
  id: string
  name: string
  sign: SignSpec
  elements: El[]
  fin: FinalizeSettings
  bridgeOverrides: Record<string, number>
  updatedAt: number
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export const defaultFin: FinalizeSettings = { bridgeWidth: 1.2, clearance: 1.5, minHoleArea: 3 }

export function makeDesign(name: string, sign: SignSpec, elements: El[]): Design {
  return {
    id: uid(),
    name,
    sign,
    elements,
    fin: { ...defaultFin },
    bridgeOverrides: {},
    updatedAt: Date.now(),
  }
}

const sign = (w: number, h: number, radius = 10): SignSpec => ({
  w,
  h,
  radius,
  mountHoles: true,
  holeDia: 4,
  holeInset: 10,
})

const text = (t: string, fontId: string, heightMm: number, x: number, y: number): TextEl => ({
  id: uid(),
  kind: 'text',
  text: t,
  fontId,
  heightMm,
  x,
  y,
  spacingEm: 0,
})

const divider = (x: number, y: number, length: number, thickness: number, vertical: boolean): DividerEl => ({
  id: uid(),
  kind: 'divider',
  x,
  y,
  length,
  thickness,
  vertical,
  roundCaps: false,
})

export interface Template {
  id: string
  name: string
  hint: string
  make(): Design
}

export const templates: Template[] = [
  {
    id: 'left-right',
    name: 'Left | Right',
    hint: '40×25 cm · number left, name right',
    make: () =>
      makeDesign('Left Right sign', sign(400, 250), [
        text('Villa', 'poppins-bold', 16, 110, 90),
        text('50', 'poppins-bold', 58, 110, 150),
        divider(200, 125, 150, 1.2, true),
        text('مهندس', 'amiri-bold', 20, 290, 88),
        text('أحمد درويش', 'amiri-bold', 34, 290, 150),
      ]),
  },
  {
    id: 'up-down',
    name: 'Up | Down',
    hint: '40×25 cm · like the Mawguud lighted sign',
    make: () =>
      makeDesign('Up Down sign', sign(400, 250), [
        text('34', 'poppins-bold', 48, 200, 78),
        divider(200, 125, 300, 1.2, false),
        text('المهندس عبيد محمد', 'amiri-bold', 30, 200, 178),
      ]),
  },
  {
    id: 'vertical',
    name: 'Vertical',
    hint: '15×40 cm · door sign',
    make: () =>
      makeDesign('Vertical sign', sign(150, 400), [
        text('12', 'poppins-bold', 42, 75, 80),
        divider(75, 140, 90, 1.2, false),
        text('السيد', 'amiri-bold', 30, 75, 210),
      ]),
  },
  {
    id: 'square',
    name: 'Square',
    hint: '25×25 cm',
    make: () =>
      makeDesign('Square sign', sign(250, 250), [
        text('فيلا', 'amiri-bold', 26, 125, 66),
        text('25', 'poppins-bold', 62, 125, 132),
        text('عائلة الدرويش', 'amiri-bold', 20, 125, 200),
      ]),
  },
  {
    id: 'blank',
    name: 'Blank 30×15',
    hint: 'empty board',
    make: () => makeDesign('New sign', sign(300, 150, 8), [text('موجود', 'amiri-bold', 55, 150, 70)]),
  },
]
