// PRODUCTION BATTERY: the full order-to-machine-file path, end to end, for
// EVERY template in the catalog. A bad cut file wastes a sheet of acrylic and
// a workday - this battery is the last line before the laser.
//
//   order text -> Sign Bot (name splits + canonical arrange)
//              -> finalize (outline -> weld -> bridge)
//              -> machine .ai/.pdf bytes
//
// Hard invariants per template:
//   1. finalize raises NO warnings on a bot-designed sign
//   2. artwork stays inside the board
//   3. every enclosed hole big enough to fall out got OPENED by a bridge
//      (topological check on the final geometry - not trusting the bridge list)
//   4. bridges are sane (span, count) and cut lines carry the right bolts
//   5. the exported PDF is well-formed
//   6. the pipeline is deterministic - same order, same bytes
// Run: npm run production-tests   (writes out/production/*.pdf for eyeballing)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB, shapedToPolys } from '../src/shaping/engine'
import { setFontDataProvider } from '../src/fonts/catalog'
import { shapedAsync } from '../src/shaping/service'
import { arrangeDesign, optimizeNameSplits } from '../src/layout/arrange'
import { addBridges } from '../src/geom/bridges'
import { weld, consumeGeometryErrors } from '../src/geom/weld'
import { roundedRectRing, circleRing, barRing, signedArea } from '../src/geom/poly'
import { buildAiPdf, MAWGUUD_STYLE } from '../src/export/pdf'
import { bboxOfMulti } from '../src/geom/types'
import { makeDesign, botElements, signFromSpec, boltCenters, templateCatalog, specName, defaultFin, type Design, type El, type TemplateSpec } from '../src/model'
import type { MultiPoly } from '../src/geom/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const FONT_FILES: Record<string, string> = {
  'avenir-arabic-medium': 'public/fonts/AvenirArabic-Medium.otf',
  'century-gothic-bold': 'public/fonts/CenturyGothic-Bold.ttf',
}

// realistic order texts, rotated per template so the whole corpus gets cut
const ORDERS: Record<TemplateSpec['layout'], string[][][]> = {
  leftright: [
    [['م/يحيي', 'اسلام'], ['شقة', '20']],
    [['أ / محروس', 'عبد الحميد'], ['Villa', '20']],
    [['المهندس محمد عبد الرحمن'], ['فيلا', '125']],
    [['Eng. Mohamed Hassan'], ['Villa', '7']],
  ],
  updown: [
    [['Villa', '34'], ['المهندس عبيد محمد']],
    [['١٢٥'], ['عائلة الدرويش']],
    [['7'], ['Dr. Ahmed Hassan']],
  ],
  vertical: [
    [['12'], ['عائلة', 'الدرويش']],
    [['٩'], ['السيد']],
  ],
}

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail: string) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL ${label}: ${detail}`)
  }
}

async function rawGeometryOf(el: El): Promise<MultiPoly> {
  if (el.kind === 'divider') {
    return [[barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)]]
  }
  const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
  const inkH = shaped.bbox.maxY - shaped.bbox.minY
  if (!(inkH > 0)) return []
  const s = el.heightMm / (shaped.refHeight > 0 ? shaped.refHeight : inkH)
  const cx = (shaped.bbox.minX + shaped.bbox.maxX) / 2
  const cy = (shaped.bbox.minY + shaped.bbox.maxY) / 2
  return shapedToPolys(shaped, s, el.x - cx * s, el.y + cy * s, 0.03)
}

async function orderToMachineFile(design: Design): Promise<{ bytes: Uint8Array; warnings: string[]; bridges: number; geometry: MultiPoly }> {
  const raws: MultiPoly[] = []
  for (const el of design.elements) raws.push(await rawGeometryOf(el))
  const combined = weld(raws)
  const outcome = addBridges(combined, 'doc', { width: defaultFin.bridgeWidth, overshoot: 1, clearance: defaultFin.clearance, minHoleArea: defaultFin.minHoleArea, candidates: 48 }, {})
  const warnings = [...outcome.warnings, ...consumeGeometryErrors()]
  const { sign } = design
  const cutLines: MultiPoly = [[roundedRectRing(0, 0, sign.w, sign.h, sign.radius)]]
  for (const [x, y] of boltCenters(sign)) cutLines.push([circleRing(x, y, sign.boltDia / 2)])
  const bytes = buildAiPdf({ wMm: sign.w, hMm: sign.h, cutLines, shapes: outcome.geometry, style: MAWGUUD_STYLE })
  return { bytes, warnings, bridges: outcome.bridges.length, geometry: outcome.geometry }
}

async function runTemplate(spec: TemplateSpec, order: string[][], writePdf: boolean, checkDeterminism: boolean) {
  const label = specName(spec)
  const seeded = makeDesign(label, signFromSpec(spec), botElements(spec, order))
  const design = await optimizeNameSplits(seeded)
  const patches = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})

  const { bytes, warnings, bridges, geometry } = await orderToMachineFile(design)

  // 1. a bot-designed sign finalizes clean
  assert(warnings.length === 0, label, `finalize warned: ${warnings.join(' | ')}`)

  // 2. artwork inside the board
  const bb = bboxOfMulti(geometry)
  assert(geometry.length > 0, label, 'no artwork geometry at all')
  assert(bb.minX >= -0.05 && bb.minY >= -0.05 && bb.maxX <= spec.w + 0.05 && bb.maxY <= spec.h + 0.05, label, `artwork outside board: ${bb.minX.toFixed(1)},${bb.minY.toFixed(1)}..${bb.maxX.toFixed(1)},${bb.maxY.toFixed(1)}`)

  // 3. every big enclosed hole was OPENED: in the bridged geometry no interior
  // ring may still enclose an area a counter could fall out of
  for (const poly of geometry) {
    for (let r = 1; r < poly.length; r++) {
      const a = Math.abs(signedArea(poly[r]))
      assert(a < defaultFin.minHoleArea + 0.1, label, `an enclosed ${a.toFixed(1)}mm² hole survived bridging - that piece FALLS OUT on the laser`)
    }
  }

  // 4. bridge + cut-line sanity
  assert(bridges < 60, label, `implausible bridge count: ${bridges}`)
  const wantBolts = spec.boltPattern === 'sides' ? 2 : 4
  assert(boltCenters(design.sign).length === wantBolts, label, `bolt count ${boltCenters(design.sign).length} != ${wantBolts}`)

  // 5. the machine file is a well-formed PDF
  const head = Buffer.from(bytes.slice(0, 5)).toString('latin1')
  const tail = Buffer.from(bytes.slice(-32)).toString('latin1')
  assert(head === '%PDF-', label, `bad PDF header: ${head}`)
  assert(tail.includes('%%EOF'), label, 'missing %%EOF trailer')
  assert(bytes.length > 1000, label, `suspiciously small file: ${bytes.length} bytes`)

  // 6. deterministic: same order in, same bytes out
  if (checkDeterminism) {
    const again = await orderToMachineFile(design)
    assert(again.bytes.length === bytes.length && Buffer.from(again.bytes).equals(Buffer.from(bytes)), label, 'pipeline is not deterministic - two runs produced different machine files')
  }

  if (writePdf) {
    mkdirSync(join(root, 'out', 'production'), { recursive: true })
    const safe = label.replace(/[^A-Za-z0-9x-]+/g, '_')
    writeFileSync(join(root, 'out', 'production', `${safe}.pdf`), bytes)
  }
}

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  setFontDataProvider(async (id) => {
    const file = FONT_FILES[id]
    if (!file) throw new Error(`no font file for ${id}`)
    return readFileSync(join(root, file)).buffer as ArrayBuffer
  })
  const counters: Record<string, number> = { leftright: 0, updown: 0, vertical: 0 }
  let i = 0
  for (const spec of templateCatalog) {
    const orders = ORDERS[spec.layout]
    const order = orders[counters[spec.layout]++ % orders.length]
    await runTemplate(spec, order, true, i % 9 === 0)
    i++
  }
  console.log(`\n${checks} checks, ${failures} failures across ${templateCatalog.length} templates`)
  if (failures > 0) process.exit(1)
  console.log('production path: ALL GREEN - every template cuts clean')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
