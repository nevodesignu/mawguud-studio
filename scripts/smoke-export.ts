// End-to-end smoke test: shape Arabic + Latin with the app's real pipeline and
// write a machine .ai/.pdf to out/, so the artwork can be verified by rendering.
// Run: npm run smoke
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB, loadFont, shapeLine, shapedToPolys } from '../src/shaping/engine'
import { addBridges, defaultBridgeSettings } from '../src/geom/bridges'
import { weld } from '../src/geom/weld'
import { roundedRectRing, circleRing, barRing } from '../src/geom/poly'
import { buildAiPdf } from '../src/export/pdf'
import type { MultiPoly } from '../src/geom/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  const amiri = loadFont('amiri', readFileSync(join(root, 'public/fonts/Amiri-Bold.ttf')).buffer as ArrayBuffer)
  const poppins = loadFont('poppins', readFileSync(join(root, 'public/fonts/Poppins-Bold.ttf')).buffer as ArrayBuffer)

  const W = 400
  const H = 250

  const place = (font: ReturnType<typeof loadFont>, text: string, heightMm: number, cx: number, cy: number) => {
    const shaped = shapeLine(font, text, 0)
    const inkH = shaped.bbox.maxY - shaped.bbox.minY
    const s = heightMm / inkH
    const bcx = (shaped.bbox.minX + shaped.bbox.maxX) / 2
    const bcy = (shaped.bbox.minY + shaped.bbox.maxY) / 2
    return shapedToPolys(shaped, s, cx - bcx * s, cy + bcy * s, 0.03)
  }

  const arabic = place(amiri, 'المهندس عبيد محمد', 34, 200, 178)
  const number = place(poppins, '34', 48, 200, 78)
  const mixed = place(amiri, 'فيلا 50', 20, 200, 228)
  const divider: MultiPoly = [[barRing(200, 125, 300, 1.2, false, false)]]
  // deliberately overlap a bar with the bottom text line: welding must happen
  // BEFORE bridging so the welded compound still gets correct bridges
  const crossBar: MultiPoly = [[barRing(200, 228, 320, 1.2, false, false)]]

  // production order: weld everything, THEN bridge the combined shape
  const combined = weld([arabic, number, mixed, divider, crossBar])
  const outcome = addBridges(combined, 'doc', defaultBridgeSettings, {})
  const bridgeCount = outcome.bridges.length
  for (const w of outcome.warnings) console.log(`[warn] ${w}`)
  const shapes: MultiPoly[] = [outcome.geometry]

  const cutLines: MultiPoly = [[roundedRectRing(0, 0, W, H, 10)]]
  for (const [x, y] of [
    [10, 10],
    [W - 10, 10],
    [W - 10, H - 10],
    [10, H - 10],
  ] as [number, number][]) {
    cutLines.push([circleRing(x, y, 2)])
  }

  const bytes = buildAiPdf({ wMm: W, hMm: H, cutLines, shapes: shapes[0] })
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'smoke.ai'), bytes)
  writeFileSync(join(root, 'out', 'smoke.pdf'), bytes)
  console.log(`ok: ${bridgeCount} bridges, ${bytes.length} bytes -> out/smoke.ai + out/smoke.pdf`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
