import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB } from '../src/shaping/engine'
import { setFontDataProvider } from '../src/fonts/catalog'
import { arrangeDesign } from '../src/layout/arrange'
import { makeDesign, botElements, signFromSpec, type TemplateSpec, type TextEl } from '../src/model'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONTS: Record<string, string> = {
  'avenir-arabic-medium': 'public/fonts/AvenirArabic-Medium.otf',
  'century-gothic-bold': 'public/fonts/CenturyGothic-Bold.ttf',
}

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  setFontDataProvider(async (id) => readFileSync(join(root, FONTS[id])).buffer as ArrayBuffer)
  const sp: TemplateSpec = { finish: 'lighted', layout: 'leftright', w: 400, h: 250, boltDia: 13.4, boltInsetX: 32.8, boltInsetY: 32.8, boltPattern: 'corners', divThick: 2.85 }
  const d = makeDesign('t', signFromSpec(sp), botElements(sp, [['أ / محروس', 'عبد الحميد'], ['منيل', 'جويدة']]))
  const first = await arrangeDesign(d, {})
  for (const el of d.elements) Object.assign(el, first[el.id] ?? {})
  console.log('canonical:', d.elements.filter((e): e is TextEl => e.kind === 'text').map((e) => e.heightMm).join(','))
  const big = d.elements.find((e): e is TextEl => e.kind === 'text' && e.text.includes('عبد'))!
  big.heightMm = 35
  const second = await arrangeDesign(d, { respectSizes: true })
  for (const el of d.elements) Object.assign(el, second[el.id] ?? {})
  console.log('respect(35):', d.elements.filter((e): e is TextEl => e.kind === 'text').map((e) => e.heightMm).join(','))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
