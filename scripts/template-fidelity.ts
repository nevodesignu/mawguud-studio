// TEMPLATE FIDELITY: the shipped catalog must match the owner's real production
// .ai templates, measured from the CUT PATHS themselves (not the stroked
// outlines - that mistake made every hole and bar ~0.35mm oversize once).
//
// Ground truth below was extracted from the 27-file template pack the owner
// sent on 2026-08-27 by interpreting each PDF content stream. Re-measure with
// scripts/measure-templates.py if the pack is ever updated.
// Run: npm run template-tests
import { templateCatalog, boltCenters, signFromSpec, specName, type TemplateSpec } from '../src/model'

interface Measured {
  finish: 'lighted' | 'mirror'
  layout: 'leftright' | 'updown' | 'vertical'
  w: number
  h: number
  dia: number
  inset: number
  sides: boolean
  divThick: number
  radius: number // corner fillet measured from the board path
}

// board, bolt diameter, bolt inset, bolt pattern, divider thickness - all mm
const MEASURED: Measured[] = [
  { finish: 'lighted', layout: 'leftright', w: 400, h: 250, dia: 12.99, inset: 32.48, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'lighted', layout: 'leftright', w: 500, h: 300, dia: 12.99, inset: 32.49, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'lighted', layout: 'leftright', w: 600, h: 350, dia: 13.0, inset: 32.47, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'lighted', layout: 'leftright', w: 700, h: 400, dia: 13.0, inset: 32.47, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'lighted', layout: 'updown', w: 400, h: 250, dia: 12.99, inset: 32.48, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'lighted', layout: 'updown', w: 500, h: 300, dia: 12.99, inset: 32.49, sides: false, divThick: 3.0, radius: 3.5 },
  { finish: 'lighted', layout: 'updown', w: 600, h: 350, dia: 13.0, inset: 32.47, sides: false, divThick: 3.0, radius: 3.5 },
  { finish: 'lighted', layout: 'updown', w: 700, h: 400, dia: 13.0, inset: 32.47, sides: false, divThick: 3.0, radius: 3.5 },
  { finish: 'lighted', layout: 'vertical', w: 250, h: 400, dia: 12.99, inset: 32.48, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'lighted', layout: 'vertical', w: 300, h: 500, dia: 12.99, inset: 32.49, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'lighted', layout: 'vertical', w: 350, h: 600, dia: 13.0, inset: 32.47, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'lighted', layout: 'vertical', w: 400, h: 700, dia: 13.0, inset: 32.47, sides: false, divThick: 2.5, radius: 3.5 },
  { finish: 'mirror', layout: 'leftright', w: 300, h: 150, dia: 6.5, inset: 14.99, sides: true, divThick: 2.25, radius: 2.49 },
  { finish: 'mirror', layout: 'leftright', w: 400, h: 200, dia: 6.2, inset: 23.27, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'mirror', layout: 'leftright', w: 500, h: 250, dia: 6.5, inset: 29.09, sides: false, divThick: 2.6, radius: 3.5 },
  { finish: 'mirror', layout: 'leftright', w: 600, h: 300, dia: 7.0, inset: 34.91, sides: false, divThick: 2.7, radius: 3.5 },
  { finish: 'mirror', layout: 'leftright', w: 700, h: 350, dia: 7.5, inset: 40.73, sides: false, divThick: 2.9, radius: 3.5 },
  { finish: 'mirror', layout: 'updown', w: 300, h: 150, dia: 6.0, inset: 17.99, sides: true, divThick: 2.4, radius: 2.49 },
  { finish: 'mirror', layout: 'updown', w: 400, h: 200, dia: 6.2, inset: 23.27, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'mirror', layout: 'updown', w: 500, h: 250, dia: 6.5, inset: 29.09, sides: false, divThick: 2.7, radius: 3.5 },
  { finish: 'mirror', layout: 'updown', w: 600, h: 300, dia: 7.0, inset: 34.91, sides: false, divThick: 2.8, radius: 3.5 },
  { finish: 'mirror', layout: 'updown', w: 700, h: 350, dia: 7.5, inset: 40.73, sides: false, divThick: 2.9, radius: 3.5 },
  { finish: 'mirror', layout: 'vertical', w: 150, h: 300, dia: 6.0, inset: 13.96, sides: true, divThick: 2.3, radius: 2.49 },
  { finish: 'mirror', layout: 'vertical', w: 200, h: 400, dia: 6.2, inset: 23.27, sides: false, divThick: 2.5, radius: 2.49 },
  { finish: 'mirror', layout: 'vertical', w: 250, h: 500, dia: 6.5, inset: 29.09, sides: false, divThick: 2.7, radius: 3.5 },
  { finish: 'mirror', layout: 'vertical', w: 300, h: 600, dia: 7.0, inset: 34.91, sides: false, divThick: 2.7, radius: 3.5 },
  { finish: 'mirror', layout: 'vertical', w: 350, h: 700, dia: 7.5, inset: 40.73, sides: false, divThick: 2.9, radius: 3.5 },
]

const TOL = 0.11 // mm - measurement noise on a path sampled from a real file

let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail: string) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL ${label}: ${detail}`)
  }
}

const key = (t: { finish: string; layout: string; w: number; h: number }) => `${t.finish}/${t.layout}/${t.w}x${t.h}`

function main() {
  const byKey = new Map(templateCatalog.map((t) => [key(t), t] as [string, TemplateSpec]))
  assert(templateCatalog.length === MEASURED.length, 'CATALOG', `catalog has ${templateCatalog.length} products, the template pack has ${MEASURED.length}`)

  for (const m of MEASURED) {
    const label = key(m)
    const t = byKey.get(label)
    assert(!!t, label, 'product missing from the catalog')
    if (!t) continue
    assert(Math.abs(t.boltDia - m.dia) <= TOL, label, `bolt diameter ${t.boltDia} vs measured ${m.dia}`)
    assert(Math.abs(t.boltInsetX - m.inset) <= TOL, label, `bolt inset ${t.boltInsetX} vs measured ${m.inset}`)
    assert(Math.abs(t.divThick - m.divThick) <= TOL, label, `divider thickness ${t.divThick} vs measured ${m.divThick}`)
    assert((t.boltPattern === 'sides') === m.sides, label, `bolt pattern ${t.boltPattern} vs measured ${m.sides ? 'sides' : 'corners'}`)
    // the real boards are ROUNDED (fillets measured from the board paths -
    // sharp corners were wrong); files carry a uniform ~0.9995 draw scale, so
    // allow a wider tolerance here
    assert(Math.abs(t.radius - m.radius) <= 0.15, label, `corner radius ${t.radius} vs measured ${m.radius}`)

    const centers = boltCenters(signFromSpec(t))
    assert(centers.length === (m.sides ? 2 : 4), label, `${centers.length} bolts, expected ${m.sides ? 2 : 4}`)
    for (const [bx, by] of centers) {
      assert(bx > 0 && by > 0 && bx < t.w && by < t.h, label, `bolt (${bx},${by}) outside the board`)
      assert(bx - t.boltDia / 2 > 2 && by - t.boltDia / 2 > 2, label, `bolt (${bx},${by}) too close to the edge`)
    }
    if (m.sides) {
      for (const [, by] of centers) assert(Math.abs(by - t.h / 2) < 0.01, label, `side bolts must sit at mid-height, got ${by}`)
    }
  }

  // LAW 10 (owner, from this pack): the divider is welded to the bolt axis on
  // exactly one product family - VERTICAL boards with the two middle bolts.
  const pinned = templateCatalog.filter((t) => t.boltPattern === 'sides' && t.h > t.w).map(specName)
  const sideBolted = templateCatalog.filter((t) => t.boltPattern === 'sides').map(specName)
  assert(pinned.length === 1 && pinned[0].includes('Vertical'), 'LAW 10', `expected exactly one bolt-axis product, got: ${pinned.join(', ')}`)
  assert(sideBolted.length === 3, 'LAW 10', `expected 3 side-bolt products in the pack, got ${sideBolted.length}`)

  console.log(`\n${checks} checks, ${failures} failures across ${MEASURED.length} real templates`)
  if (failures > 0) process.exit(1)
  console.log('template fidelity: ALL GREEN - the catalog matches the production files')
}

main()
