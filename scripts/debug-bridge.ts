// Debug: why does the "e" counter bridge not pick the crossbar crossing?
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB, loadFont, shapeLine, shapedToPolys } from '../src/shaping/engine'
import { ringArea, ringCentroid, ringInterpolate, ringLength } from '../src/geom/poly'
import { addBridges, defaultBridgeSettings } from '../src/geom/bridges'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  const poppins = loadFont('poppins', readFileSync(join(root, 'public/fonts/Poppins-Bold.ttf')).buffer as ArrayBuffer)
  const shaped = shapeLine(poppins, 'e', 0)
  const inkH = shaped.bbox.maxY - shaped.bbox.minY
  const s = 110 / inkH
  const mp = shapedToPolys(shaped, s, 100, 130, 0.03)
  console.log('polys:', mp.length)
  for (const poly of mp) {
    console.log('rings:', poly.length, 'ext area', ringArea(poly[0]).toFixed(0))
    for (const h of poly.slice(1)) {
      const c = ringCentroid(h)
      console.log('  hole area', ringArea(h).toFixed(0), 'centroid', c.map((v) => v.toFixed(1)).join(','), 'len', ringLength(h).toFixed(0))
      // print a few ring samples to understand orientation/geometry
      for (let i = 0; i < 8; i++) {
        const p = ringInterpolate(h, i / 8)
        console.log('    t=' + (i / 8).toFixed(3), p.map((v) => v.toFixed(1)).join(','))
      }
    }
  }
  const outcome = addBridges(mp, 'e', defaultBridgeSettings, {})
  for (const b of outcome.bridges) {
    console.log('bridge span', b.span.toFixed(1), 'a', b.a.map((v) => v.toFixed(1)).join(','), 'b', b.b.map((v) => v.toFixed(1)).join(','))
  }
  console.log('warnings', outcome.warnings)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
