// Visual preview of the Sign Bot's canonical layouts: builds representative bot
// designs, arranges them, and writes out/<prefix>-<case>.pdf (board outline +
// bolts as hairlines, text + divider filled) so proportions can be eyeballed
// by rendering the PDFs to PNG.
// Run: npx tsx scripts/render-signs.ts [prefix]   (default prefix: "preview")
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB } from '../src/shaping/engine'
import { shapedToPolys } from '../src/shaping/engine'
import { setFontDataProvider } from '../src/fonts/catalog'
import { shapedAsync } from '../src/shaping/service'
import { arrangeDesign } from '../src/layout/arrange'
import { roundedRectRing, circleRing, barRing } from '../src/geom/poly'
import { weld } from '../src/geom/weld'
import { buildAiPdf } from '../src/export/pdf'
import { makeDesign, botElements, signFromSpec, boltCenters, type TemplateSpec, type Layout } from '../src/model'
import type { MultiPoly } from '../src/geom/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const FONT_FILES: Record<string, string> = {
  'avenir-arabic-medium': 'public/fonts/AvenirArabic-Medium.otf',
  'century-gothic-bold': 'public/fonts/CenturyGothic-Bold.ttf',
}

const mirror = (layout: Layout, w: number, h: number): TemplateSpec => ({
  finish: 'mirror',
  layout,
  w,
  h,
  boltDia: 6.6,
  boltInsetX: 23.6,
  boltInsetY: 23.6,
  boltPattern: 'sides',
  divThick: 2.85,
})

const CASES: { name: string; spec: TemplateSpec; groups: string[][] }[] = [
  { name: 'golden', spec: mirror('leftright', 400, 200), groups: [['م/يحيي', 'اسلام'], ['شقة', '20']] },
  { name: 'villa-row', spec: mirror('updown', 400, 200), groups: [['Villa', '34'], ['المهندس عبيد محمد']] },
  { name: 'villa-ar', spec: mirror('updown', 400, 200), groups: [['فيلا', '34'], ['المهندس عبيد محمد']] },
  { name: 'number-top', spec: mirror('updown', 400, 250), groups: [['34'], ['المهندس عبيد محمد']] },
  { name: 'one-row', spec: mirror('leftright', 300, 150), groups: [['223'], ['B']] },
]

async function main() {
  const prefix = process.argv[2] ?? 'preview'
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  setFontDataProvider(async (id) => {
    const file = FONT_FILES[id]
    if (!file) throw new Error(`no font file for ${id}`)
    return readFileSync(join(root, file)).buffer as ArrayBuffer
  })
  mkdirSync(join(root, 'out'), { recursive: true })

  for (const c of CASES) {
    const design = makeDesign(c.name, signFromSpec(c.spec), botElements(c.spec, c.groups))
    const patches = await arrangeDesign(design, { mode: 'canonical' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})

    const parts: MultiPoly[] = []
    const sizes: string[] = []
    for (const el of design.elements) {
      if (el.kind === 'divider') {
        parts.push([[barRing(el.x, el.y, el.length, el.thickness, el.vertical, false)]])
      } else if (el.kind === 'text' && el.text.trim()) {
        const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
        const ref = shaped.refHeight > 0 ? shaped.refHeight : shaped.bbox.maxY - shaped.bbox.minY
        const s = el.heightMm / ref
        const bcx = (shaped.bbox.minX + shaped.bbox.maxX) / 2
        const bcy = (shaped.bbox.minY + shaped.bbox.maxY) / 2
        parts.push(shapedToPolys(shaped, s, el.x - bcx * s, el.y + bcy * s, 0.03))
        sizes.push(`"${el.text}" ${el.heightMm}mm`)
      }
    }

    const { w, h } = design.sign
    const cutLines: MultiPoly = [[roundedRectRing(0, 0, w, h, 0.1)]]
    for (const [x, y] of boltCenters(design.sign)) cutLines.push([circleRing(x, y, design.sign.boltDia / 2)])

    const bytes = buildAiPdf({ wMm: w, hMm: h, cutLines, shapes: weld(parts) })
    writeFileSync(join(root, 'out', `${prefix}-${c.name}.pdf`), bytes)
    console.log(`${prefix}-${c.name}: ${sizes.join(', ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
