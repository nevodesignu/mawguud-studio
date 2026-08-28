// Layout engine test battery: runs arrangeDesign against a corpus of real-world
// sign texts (Arabic names, titles, digits, English, multi-line, one-sided) on
// several board sizes, and asserts hard invariants on every result:
//   1. everything stays inside the board
//   2. the whole composition (text + divider) is centered on the board
//   3. text never collides with the divider
//   4. running arrange twice changes nothing (idempotence)
// Run: npm run layout-tests
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB } from '../src/shaping/engine'
import { setFontDataProvider } from '../src/fonts/catalog'
import { shapedAsync } from '../src/shaping/service'
import { arrangeDesign, optimizeNameSplits } from '../src/layout/arrange'
import { makeDesign, makeFromSpec, botElements, signFromSpec, boltCenters, templateCatalog, type TemplateSpec, type Design, type TextEl, type Layout } from '../src/model'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const FONT_FILES: Record<string, string> = {
  'avenir-arabic-medium': 'public/fonts/AvenirArabic-Medium.otf',
  'century-gothic-bold': 'public/fonts/CenturyGothic-Bold.ttf',
  'century-gothic': 'public/fonts/CenturyGothic-Regular.ttf',
  'amiri-bold': 'public/fonts/Amiri-Bold.ttf',
  'tajawal-bold': 'public/fonts/Tajawal-Bold.ttf',
  'almarai-bold': 'public/fonts/Almarai-Bold.ttf',
  'poppins-bold': 'public/fonts/Poppins-Bold.ttf',
}

const spec = (layout: Layout, w: number, h: number): TemplateSpec => ({
  finish: 'lighted',
  layout,
  w,
  h,
  boltDia: 13.4,
  boltInsetX: 32.8,
  boltInsetY: 32.8,
  boltPattern: 'corners',
  divThick: 2.85,
  radius: 2.5,
})

interface Case {
  name: string
  layout: Layout
  groups: string[][]
}

const CASES: Case[] = [
  { name: 'classic LR', layout: 'leftright', groups: [['أ / محروس', 'عبد الحميد'], ['منيل', 'جويدة']] },
  { name: 'long name right', layout: 'leftright', groups: [['المهندس محمد عبد الرحمن الطويل'], ['فيلا', '125']] },
  { name: 'doctor short', layout: 'leftright', groups: [['د / سارة'], ['شقة', '12']] },
  { name: 'english LR', layout: 'leftright', groups: [['Eng. Mohamed Hassan'], ['Villa', '7']] },
  { name: 'empty left', layout: 'leftright', groups: [['أ.د / عبد العزيز', 'الشربيني'], []] },
  { name: 'empty right', layout: 'leftright', groups: [[], ['50']] },
  { name: 'single chars', layout: 'leftright', groups: [['م'], ['٥']] },
  { name: 'family + building', layout: 'leftright', groups: [['عائلة السيد أحمد', 'وأولاده'], ['عمارة', '٣٤']] },
  { name: 'mixed digits LR', layout: 'leftright', groups: [['فيلا 50'], ['م / أحمد']] },
  { name: 'three lines right', layout: 'leftright', groups: [['الأستاذ الدكتور', 'محمد علي', 'استشاري قلب'], ['عيادة', '٣']] },
  { name: 'classic UD', layout: 'updown', groups: [['34'], ['المهندس عبيد محمد']] },
  { name: 'english UD', layout: 'updown', groups: [['Villa 3'], ['Khaled Elwany']] },
  { name: 'arabic digits UD', layout: 'updown', groups: [['١٢٥'], ['عائلة الدرويش الكريمة جدا']] },
  { name: 'dr UD', layout: 'updown', groups: [['7'], ['Dr. Ahmed Hassan']] },
  { name: 'two-line bottom UD', layout: 'updown', groups: [['12'], ['المهندس أحمد', 'عبد الفتاح']] },
  { name: 'no top UD', layout: 'updown', groups: [[], ['عائلة المهندس']] },
  { name: 'vertical door', layout: 'vertical', groups: [['12'], ['السيد']] },
  { name: 'vertical family', layout: 'vertical', groups: [['٩'], ['عائلة', 'المهندس أحمد']] },
  { name: 'vertical english', layout: 'vertical', groups: [['21'], ['Office', 'Dr. Mona']] },
]

const BOARDS: Record<Layout, [number, number][]> = {
  leftright: [
    [400, 250],
    [700, 400],
    [300, 150],
  ],
  updown: [
    [400, 250],
    [700, 400],
    [300, 150],
  ],
  vertical: [
    [250, 400],
    [150, 300],
    [400, 700],
  ],
}

interface PlacedText {
  el: TextEl
  left: number
  right: number
  top: number
  bottom: number
}

async function placed(design: Design): Promise<{ texts: PlacedText[]; div: { x: number; y: number; vertical: boolean; length: number; thickness: number } | null }> {
  const texts: PlacedText[] = []
  for (const el of design.elements) {
    if (el.kind !== 'text' || !el.text.trim()) continue
    const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
    const iw = shaped.bbox.maxX - shaped.bbox.minX
    const ih = shaped.bbox.maxY - shaped.bbox.minY
    const s = el.heightMm / (shaped.refHeight > 0 ? shaped.refHeight : ih)
    const wMm = iw * s
    const hMm = ih * s
    texts.push({ el, left: el.x - wMm / 2, right: el.x + wMm / 2, top: el.y - hMm / 2, bottom: el.y + hMm / 2 })
  }
  const d = design.elements.find((e) => e.kind === 'divider')
  return { texts, div: d && d.kind === 'divider' ? d : null }
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

/** LAW 22 invariant: letter ink keeps clear air from every bolt hole. */
async function assertTextClearOfBolts(design: Design, label: string, minGap: number) {
  const centers = boltCenters(design.sign)
  if (!centers.length) return
  const rad = design.sign.boltDia / 2
  const { texts } = await placed(design)
  for (const t of texts) {
    for (const [bx, by] of centers) {
      const dx = Math.max(0, Math.max(t.left - bx, bx - t.right))
      const dy = Math.max(0, Math.max(t.top - by, by - t.bottom))
      const dist = Math.hypot(dx, dy) - rad
      assert(dist >= minGap, label, `LAW 22: "${t.el.text}" is ${dist.toFixed(1)}mm from the bolt at (${bx.toFixed(0)},${by.toFixed(0)}) (needs >= ${minGap})`)
    }
  }
}

/** LAW 19 invariant: the divider keeps at least `minGap` mm of air from every bolt circle. */
function assertDividerClear(design: Design, label: string, minGap: number) {
  const div = design.elements.find((e) => e.kind === 'divider')
  if (!div || div.kind !== 'divider') return
  const r = design.sign.boltDia / 2
  const hx = div.vertical ? div.thickness / 2 : div.length / 2
  const hy = div.vertical ? div.length / 2 : div.thickness / 2
  for (const [bx, by] of boltCenters(design.sign)) {
    const dx = Math.max(0, Math.abs(bx - div.x) - hx)
    const dy = Math.max(0, Math.abs(by - div.y) - hy)
    const dist = Math.hypot(dx, dy) - r
    assert(dist >= minGap, label, `divider is ${dist.toFixed(1)}mm from the bolt at (${bx.toFixed(0)},${by.toFixed(0)}) (needs >= ${minGap})`)
  }
}

async function runCase(c: Case, w: number, h: number) {
  const sp = spec(c.layout, w, h)
  const design = makeDesign(`${c.name} ${w}x${h}`, signFromSpec(sp), botElements(sp, c.groups))
  const apply = async () => {
    const patches = await arrangeDesign(design, { mode: 'canonical' })
    for (const el of design.elements) {
      const p = patches[el.id]
      if (p) Object.assign(el, p)
    }
    return patches
  }
  const first = await apply()
  const { texts, div } = await placed(design)

  const label = `${c.name} @${w}x${h}`
  // 1. containment
  for (const t of texts) {
    assert(t.left >= 1 && t.right <= w - 1, label, `"${t.el.text}" overflows horizontally (${t.left.toFixed(1)}..${t.right.toFixed(1)} on ${w})`)
    assert(t.top >= 1 && t.bottom <= h - 1, label, `"${t.el.text}" overflows vertically (${t.top.toFixed(1)}..${t.bottom.toFixed(1)} on ${h})`)
  }
  if (div) {
    const dl = div.vertical ? div.x - div.thickness / 2 : div.x - div.length / 2
    const dr = div.vertical ? div.x + div.thickness / 2 : div.x + div.length / 2
    const dt = div.vertical ? div.y - div.length / 2 : div.y - div.thickness / 2
    const db = div.vertical ? div.y + div.length / 2 : div.y + div.thickness / 2
    assert(dl >= 0 && dr <= w && dt >= 0 && db <= h, label, `divider out of board`)
    // 3. no text/divider collision
    for (const t of texts) {
      const overlapX = Math.min(t.right, dr) - Math.max(t.left, dl)
      const overlapY = Math.min(t.bottom, db) - Math.max(t.top, dt)
      assert(!(overlapX > 0.5 && overlapY > 0.5), label, `"${t.el.text}" collides with divider`)
    }
    // LAW 19: never touching a bolt circle either
    assertDividerClear(design, label, 1)
  }
  // LAW 22: no letter touches a bolt hole
  await assertTextClearOfBolts(design, label, 1.5)
  // 2. LAW 21 (final form): the whole composition - text + divider, one
  // group - is centered on the board
  if (texts.length) {
    const allL = Math.min(...texts.map((t) => t.left), div ? (div.vertical ? div.x - div.thickness / 2 : div.x - div.length / 2) : Infinity)
    const allR = Math.max(...texts.map((t) => t.right), div ? (div.vertical ? div.x + div.thickness / 2 : div.x + div.length / 2) : -Infinity)
    const allT = Math.min(...texts.map((t) => t.top), div ? (div.vertical ? div.y - div.length / 2 : div.y - div.thickness / 2) : Infinity)
    const allB = Math.max(...texts.map((t) => t.bottom), div ? (div.vertical ? div.y + div.length / 2 : div.y + div.thickness / 2) : -Infinity)
    const cx = (allL + allR) / 2
    const cy = (allT + allB) / 2
    // ink descenders/hamzas shift the measured ink-center a little from the
    // typographic center the engine aligns - allow ~1.5% of the board
    assert(Math.abs(cx - w / 2) <= Math.max(0.8, 0.015 * w), label, `composition off-center horizontally: ${cx.toFixed(1)} vs ${(w / 2).toFixed(1)}`)
    assert(Math.abs(cy - h / 2) <= Math.max(0.8, 0.02 * h), label, `composition off-center vertically: ${cy.toFixed(1)} vs ${(h / 2).toFixed(1)}`)
  }
  // 4. idempotence
  const second = await apply()
  for (const id of Object.keys(second)) {
    const a = first[id]
    const b = second[id]
    if (!a || !b) continue
    for (const k of ['x', 'y', 'heightMm', 'length'] as const) {
      if (a[k] !== undefined && b[k] !== undefined) {
        assert(Math.abs((a[k] as number) - (b[k] as number)) <= 0.2, label, `not idempotent: ${k} ${a[k]} -> ${b[k]}`)
      }
    }
  }
}

/**
 * GOLDEN MASTER - approved by the owner on 2026-08-27 ("this one is perfect"),
 * re-baselined the same day for LAW 18 (owner: numbers were "super huge" at
 * 2.0x/30% - now 1.45x/24%): bot(["م/يحيي","اسلام"] | ["شقة","20"]) on Mirror
 * 40x20 must produce exactly names 33.1mm, label 28.1mm, number 48mm. Any
 * engine change that moves these numbers changes the production look - and fails.
 */
async function goldenMaster() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('golden', signFromSpec(sp), botElements(sp, [['م/يحيي', 'اسلام'], ['شقة', '20']]))
  const patches = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) {
    const p = patches[el.id]
    if (p) Object.assign(el, p)
  }
  const label = 'GOLDEN شقة/20'
  const byText = (t: string) => design.elements.find((e) => e.kind === 'text' && e.text === t) as TextEl
  const near = (v: number, want: number, tol: number, what: string) => assert(Math.abs(v - want) <= tol, label, `${what}: ${v} (approved: ${want})`)
  // re-baselined 2026-08-27 with the Century Gothic reference-height fix:
  // the number's PHYSICAL size is unchanged (55mm true letter height ==
  // the approved look) - heightMm just tells the truth now
  near(byText('م/يحيي').heightMm, 33.3, 0.5, 'name line height')
  near(byText('اسلام').heightMm, 33.3, 0.5, 'name line height')
  near(byText('شقة').heightMm, 28.3, 0.5, 'label height')
  near(byText('20').heightMm, 55, 0.5, 'number height')
  const d = design.elements.find((e) => e.kind === 'divider')
  // content-matched divider follows the name column; it sits between the
  // columns wherever the content puts it (LAW 21 centers the whole GROUP,
  // it never pins the divider itself)
  if (d && d.kind === 'divider') near(d.length, 119.3, 2, 'divider length')
  if (d && d.kind === 'divider') near(d.x, 177.3, 2, 'divider x (between the columns)')
}

/**
 * SIZING SOVEREIGNTY (final form): the canonical base look is the FLOOR.
 * User sizes ABOVE the base are kept exactly; sizes BELOW the base rise to
 * it - text never renders smaller than the base, and never shrinks.
 */
async function sizingSovereignty() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }
  const base = makeDesign('sov', signFromSpec(sp), botElements(sp, [['Villa', '180'], ['المهندس عبيد محمد']]))
  const t = (design: Design, txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  // arrange canonically first, like a real session: the base floor is defined
  // for the arrangement the design actually has (villa-row here)
  const canonPatches = await arrangeDesign(JSON.parse(JSON.stringify(base)), { mode: 'canonical' })
  for (const el of base.elements) Object.assign(el, canonPatches[el.id] ?? {})
  const canonName = canonPatches[t(base, 'المهندس عبيد محمد').id]?.heightMm ?? 0
  const canonNum = canonPatches[t(base, '180').id]?.heightMm ?? 0
  const label = 'SOVEREIGNTY Villa/180'
  assert(canonName > 5 && canonNum > 5, label, `canonical heights implausible: ${canonName}/${canonNum}`)
  const above = canonName + 15
  t(base, 'المهندس عبيد محمد').heightMm = above // deliberate: bigger than base
  t(base, '180').heightMm = Math.max(1, canonNum - 20) // stale: smaller than base
  const handSized = Math.max(3, canonNum - 25)
  t(base, 'Villa').heightMm = handSized
  t(base, 'Villa').sized = true // the user resized this by hand - it is FINAL
  const patches = await arrangeDesign(base, { mode: 'layout' })
  const nameH = patches[t(base, 'المهندس عبيد محمد').id]?.heightMm ?? 0
  const numH = patches[t(base, '180').id]?.heightMm ?? 0
  const villaH = patches[t(base, 'Villa').id]?.heightMm ?? 0
  assert(Math.abs(nameH - above) < 0.11, label, `above-base size not kept: ${above} -> ${nameH}`)
  assert(Math.abs(numH - canonNum) < 0.11, label, `below-base size not raised to base: ${numH} vs ${canonNum}`)
  assert(Math.abs(villaH - handSized) < 0.11, label, `hand-resized size was overridden: ${handSized} -> ${villaH}`)
}

/**
 * PERFECT-IT = CLEAN UP MY ARRANGEMENT (owner 2026-08-27, final: "the perfect
 * it button doesnt work, plan it all over"). The user's current positions are
 * the spec - side of the divider, block membership, line order, block
 * position. The engine perfects the geometry: tight ink spacing, one X per
 * column, level rows, divider re-fit mid-gap, whole ensemble centered.
 */
async function perfectItCleanup() {
  const label = 'PERFECT-IT CLEANUP'
  const centered = async (design: Design, w: number, h: number, what: string) => {
    const { texts, div } = await placed(design)
    const allL = Math.min(...texts.map((t) => t.left), div ? (div.vertical ? div.x - div.thickness / 2 : div.x - div.length / 2) : Infinity)
    const allR = Math.max(...texts.map((t) => t.right), div ? (div.vertical ? div.x + div.thickness / 2 : div.x + div.length / 2) : -Infinity)
    const allT = Math.min(...texts.map((t) => t.top), div ? (div.vertical ? div.y - div.length / 2 : div.y - div.thickness / 2) : Infinity)
    const allB = Math.max(...texts.map((t) => t.bottom), div ? (div.vertical ? div.y + div.length / 2 : div.y + div.thickness / 2) : -Infinity)
    assert(Math.abs((allL + allR) / 2 - w / 2) <= Math.max(0.8, 0.015 * w), label, `${what}: group off-center horizontally: ${((allL + allR) / 2).toFixed(1)}`)
    assert(Math.abs((allT + allB) / 2 - h / 2) <= Math.max(0.8, 0.02 * h), label, `${what}: group off-center vertically: ${((allT + allB) / 2).toFixed(1)}`)
  }
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }
  const fresh = async () => {
    const design = makeDesign('cleanup', signFromSpec(sp), botElements(sp, [['م/يحيي', 'اسلام'], ['شقة', '20']]))
    const patches = await arrangeDesign(design, { mode: 'canonical' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
    return design
  }
  const applyLayout = async (design: Design) => {
    const patches = await arrangeDesign(design, { mode: 'layout' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  }
  const t = (design: Design, txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!

  // 1. a messy design comes out aligned: jitter every line, Perfect-it
  const d1 = await fresh()
  t(d1, 'م/يحيي').x += 4
  t(d1, 'م/يحيي').y -= 3
  t(d1, 'اسلام').x -= 6
  t(d1, 'اسلام').y += 5
  t(d1, 'شقة').x += 3
  t(d1, '20').y += 6
  const h1 = t(d1, 'م/يحيي').heightMm
  await applyLayout(d1)
  assert(Math.abs(t(d1, 'م/يحيي').x - t(d1, 'اسلام').x) < 0.11, label, `messy column did not share X: ${t(d1, 'م/يحيي').x} vs ${t(d1, 'اسلام').x}`)
  assert(Math.abs(t(d1, 'شقة').x - t(d1, '20').x) < 0.11, label, `label/number column did not share X`)
  assert(Math.abs(t(d1, 'م/يحيي').heightMm - h1) < 0.11, label, 'cleanup touched a size')
  await centered(d1, 400, 200, 'messy cleanup')
  // idempotence: hammering the button changes nothing
  const snap = d1.elements.map((e) => [e.x, e.y] as const)
  await applyLayout(d1)
  d1.elements.forEach((e, i) => {
    assert(Math.abs(e.x - snap[i][0]) <= 0.15 && Math.abs(e.y - snap[i][1]) <= 0.15, label, `not idempotent: element ${i} moved ${snap[i]} -> (${e.x},${e.y})`)
  })

  // 2. a dragged BLOCK stays where the user put it (relative to the rest)
  const d2 = await fresh()
  t(d2, 'م/يحيي').y += 25
  t(d2, 'اسلام').y += 25
  const wantDrop = 25
  const beforeGap = (t(d2, 'م/يحيي').y + t(d2, 'اسلام').y) / 2 - (t(d2, 'شقة').y + t(d2, '20').y) / 2
  await applyLayout(d2)
  const afterGap = (t(d2, 'م/يحيي').y + t(d2, 'اسلام').y) / 2 - (t(d2, 'شقة').y + t(d2, '20').y) / 2
  assert(Math.abs(afterGap - beforeGap) < 3, label, `dragged block offset not preserved: ${afterGap.toFixed(1)} vs ${beforeGap.toFixed(1)}`)
  assert(afterGap > wantDrop / 2, label, `dragged block snapped back: offset ${afterGap.toFixed(1)}`)
  await centered(d2, 400, 200, 'dragged block')

  // 3. a line dragged across the divider JOINS the other column
  const d3 = await fresh()
  const divX3 = d3.elements.find((e) => e.kind === 'divider')!.x
  t(d3, 'اسلام').x = divX3 - 60 // now left of the line
  await applyLayout(d3)
  assert(Math.abs(t(d3, 'اسلام').x - t(d3, 'شقة').x) < 0.11, label, `moved line did not join the left column: ${t(d3, 'اسلام').x} vs ${t(d3, 'شقة').x}`)
  assert(t(d3, 'م/يحيي').x > d3.elements.find((e) => e.kind === 'divider')!.x, label, 'remaining line lost its side')

  // 4. dragging a line above its sibling REORDERS the stack
  const d4 = await fresh()
  t(d4, 'اسلام').y = t(d4, 'م/يحيي').y - 30 // اسلام now on top
  await applyLayout(d4)
  assert(t(d4, 'اسلام').y < t(d4, 'م/يحيي').y, label, `stack order not taken from the user: اسلام ${t(d4, 'اسلام').y} vs م/يحيي ${t(d4, 'م/يحيي').y}`)

  // 5. the divider re-fits into the actual gap and never touches text
  const d5 = await fresh()
  t(d5, 'م/يحيي').x -= 25
  t(d5, 'اسلام').x -= 25
  await applyLayout(d5)
  const { texts: t5, div: div5 } = await placed(d5)
  assert(div5 !== null, label, 'divider vanished')
  if (div5) {
    for (const tx of t5) {
      const gapX = Math.max(div5.x - div5.thickness / 2 - tx.right, tx.left - (div5.x + div5.thickness / 2))
      assert(gapX >= 1 || tx.top > div5.y + div5.length / 2 || tx.bottom < div5.y - div5.length / 2, label, `"${tx.el.text}" touches the re-fit divider (gap ${gapX.toFixed(1)})`)
    }
  }

  // 6. one-sided sign: everything dragged into one column - idempotent, and
  // the divider rides beside the lone block instead of floating away
  const d6 = await fresh()
  const div6 = d6.elements.find((e) => e.kind === 'divider')!
  t(d6, 'شقة').x = div6.x + 50
  t(d6, '20').x = div6.x + 55
  await applyLayout(d6)
  const snap6 = d6.elements.map((e) => [e.x, e.y] as const)
  await applyLayout(d6)
  d6.elements.forEach((e, i) => {
    assert(Math.abs(e.x - snap6[i][0]) <= 0.15 && Math.abs(e.y - snap6[i][1]) <= 0.15, label, `one-sided not idempotent: element ${i} moved (${snap6[i]}) -> (${e.x},${e.y})`)
  })
  const { texts: t6, div: div6f } = await placed(d6)
  if (div6f) {
    const blockLeft = Math.min(...t6.map((x) => x.left))
    const gap6 = blockLeft - (div6f.x + div6f.thickness / 2)
    assert(gap6 > 5 && gap6 < 0.1 * 400, label, `divider not riding beside the lone block: gap ${gap6.toFixed(1)}mm`)
  }

  // 7. a label the user STACKED over its number stays a stack - the villa-row
  // heuristic must not flatten it onto one line
  const spUD: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'corners', divThick: 2.85 }
  const d7 = makeDesign('cleanup7', signFromSpec(spUD), botElements(spUD, [['شقة', '20'], ['المهندس عبيد محمد']]))
  // botElements seeds the pair stacked; Perfect-it on the raw seed must keep it stacked
  await applyLayout(d7)
  const dy7 = Math.abs(t(d7, 'شقة').y - t(d7, '20').y)
  assert(dy7 > 10, label, `stacked label/number pair was flattened onto one line (dy=${dy7.toFixed(1)})`)
  assert(Math.abs(t(d7, 'شقة').x - t(d7, '20').x) < 0.11, label, 'stacked pair lost its shared X')
}


/** Side bolts sit at mid-height: the horizontal divider must run on their axis. */
async function boltAxisLaw() {
  const label = 'BOLT AXIS'
  // PINNED: a VERTICAL board with its two bolts in the middle of the sides -
  // the owner's Mirror Vertical 15x30, where the real template draws the line
  // straight through the bolt axis.
  const vert: TemplateSpec = { finish: 'mirror', layout: 'vertical', w: 150, h: 300, boltDia: 6.0, boltInsetX: 14.0, boltInsetY: 150, boltPattern: 'sides', divThick: 2.3 }
  for (const mode of ['canonical', 'layout'] as const) {
    const design = makeDesign('axis', signFromSpec(vert), botElements(vert, [['12'], ['عائلة', 'الدرويش']]))
    const patches = await arrangeDesign(design, { mode })
    const d = design.elements.find((e) => e.kind === 'divider')!
    const y = patches[d.id]?.y
    assert(y !== undefined && Math.abs(y - 150) < 0.11, label, `vertical sign: divider off the bolt axis (${mode}): y=${y} vs 150`)
  }
  // and it STAYS pinned when the user drags the blocks around
  const dragged = makeDesign('axis2', signFromSpec(vert), botElements(vert, [['12'], ['عائلة', 'الدرويش']]))
  const p0 = await arrangeDesign(dragged, { mode: 'canonical' })
  for (const el of dragged.elements) Object.assign(el, p0[el.id] ?? {})
  for (const el of dragged.elements) if (el.kind === 'text') el.y += el.y < 150 ? -18 : 12
  const p1 = await arrangeDesign(dragged, { mode: 'layout' })
  const dv = dragged.elements.find((e) => e.kind === 'divider')!
  assert(Math.abs((p1[dv.id]?.y ?? 0) - 150) < 0.11, label, `vertical sign: dragging content moved the pinned line to ${p1[dv.id]?.y}`)

  // NOT PINNED: every other sign - "other than that divider only move". A wide
  // board with the same side-bolt pattern lets its line follow the content.
  const wide: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 300, h: 150, boltDia: 6.0, boltInsetX: 18.0, boltInsetY: 75, boltPattern: 'sides', divThick: 2.4 }
  const free = makeDesign('free', signFromSpec(wide), botElements(wide, [['34'], ['المهندس عبيد محمد']]))
  const f0 = await arrangeDesign(free, { mode: 'canonical' })
  for (const el of free.elements) Object.assign(el, f0[el.id] ?? {})
  // push the top block up hard: an unpinned line follows the gap it opens
  for (const el of free.elements) if (el.kind === 'text' && el.y < 75) el.y -= 22
  const f1 = await arrangeDesign(free, { mode: 'layout' })
  const fd = free.elements.find((e) => e.kind === 'divider')!
  const fy = f1[fd.id]?.y ?? 0
  assert(Math.abs(fy - 75) > 1.5, label, `wide side-bolt sign: divider is still welded to mid-height (y=${fy}) - it should follow the content`)
  // the freed line still never touches a bolt (LAW 19)
  for (const el of free.elements) Object.assign(el, f1[el.id] ?? {})
  assertDividerClear(free, label, 1)
}

/** LAW 11: bot text is as big as possible - the name must fill most of the width. */
async function law11BigText() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 100, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('big', signFromSpec(sp), botElements(sp, [['Villa', '34'], ['المهندس عبيد محمد']]))
  const patches = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  const { texts } = await placed(design)
  const name = texts.find((t) => t.el.text.includes('المهندس'))!
  const span = name.right - name.left
  assert(span >= 0.75 * 400, 'LAW 11', `name too small: spans ${span.toFixed(0)}mm of 400 (need >= 300)`)
  assert(span <= 0.9 * 400, 'LAW 11', `name too big: spans ${span.toFixed(0)}mm of 400`)
}

/** LAW 12 + 13: stacked texts share X, side-by-side texts share Y - even through nudges. */
async function alignmentLaws() {
  // stacked: nudge one line sideways, the column must stay on one X
  const lr: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 100, boltPattern: 'sides', divThick: 2.85 }
  const d1 = makeDesign('l12', signFromSpec(lr), botElements(lr, [['م/يحيي', 'اسلام'], ['شقة', '20']]))
  const apply = async (design: Design, mode: 'layout' | 'canonical') => {
    const patches = await arrangeDesign(design, { mode })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  }
  await apply(d1, 'canonical')
  const t = (design: Design, txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  t(d1, 'اسلام').x += 5
  await apply(d1, 'layout')
  assert(Math.abs(t(d1, 'م/يحيي').x - t(d1, 'اسلام').x) < 0.11, 'LAW 12', `stacked lines split X: ${t(d1, 'م/يحيي').x} vs ${t(d1, 'اسلام').x}`)

  // row: nudge the number down a bit, the row must stay on one Y
  const ud: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 100, boltPattern: 'corners', divThick: 2.85 }
  const d2 = makeDesign('l13', signFromSpec(ud), botElements(ud, [['Villa', '34'], ['المهندس عبيد محمد']]))
  await apply(d2, 'canonical')
  t(d2, '34').y -= 4
  await apply(d2, 'layout')
  assert(Math.abs(t(d2, 'Villa').y - t(d2, '34').y) < 0.11, 'LAW 13', `row split Y: ${t(d2, 'Villa').y} vs ${t(d2, '34').y}`)
}

/** LAW 14: near-aligned texts across the divider snap to exactly one axis. */
async function law14CrossAxis() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 100, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('l14', signFromSpec(sp), botElements(sp, [['أحمد', 'محمود'], ['منى', 'سارة']]))
  const t = (txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  // different user sizes so the ideal rows land NEAR each other but not equal
  const patches0 = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) Object.assign(el, patches0[el.id] ?? {})
  t('منى').heightMm = 34
  t('سارة').heightMm = 26
  t('أحمد').heightMm = 30
  t('محمود').heightMm = 30
  const patches = await arrangeDesign(design, { mode: 'layout' })
  for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  // cleanup keeps blocks RIGID (spacing never bends), so unequal column
  // extents settle CENTER-aligned: rows level as closely as geometry allows,
  // and the block middles weld exactly
  assert(Math.abs(t('أحمد').y - t('منى').y) < 3.5, 'LAW 14', `cross-divider rows not near: ${t('أحمد').y} vs ${t('منى').y}`)
  assert(Math.abs(t('محمود').y - t('سارة').y) < 3.5, 'LAW 14', `cross-divider rows not near (2nd): ${t('محمود').y} vs ${t('سارة').y}`)
  assert(Math.abs((t('أحمد').y + t('محمود').y) / 2 - (t('منى').y + t('سارة').y) / 2) < 0.15, 'LAW 14', `block centers not welded: ${((t('أحمد').y + t('محمود').y) / 2).toFixed(1)} vs ${((t('منى').y + t('سارة').y) / 2).toFixed(1)}`)
}

/** LAW 15: near-equal sibling sizes unify UP; clearly different sizes stay. */
async function law15SiblingSizes() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 300, h: 150, boltDia: 6.5, boltInsetX: 15.3, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('l15', signFromSpec(sp), botElements(sp, [['Ahmed', 'Malek'], ['Villa', '30']]))
  const t = (txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  // all four hand-sized (sized = final): the base floor must not lift any of
  // them, so the test isolates pure law-15 cluster semantics
  t('Ahmed').heightMm = 28.4
  t('Ahmed').sized = true
  t('Malek').heightMm = 31 // almost equal - the exact case the owner spotted
  t('Malek').sized = true
  t('Villa').heightMm = 19.1
  t('Villa').sized = true
  t('30').heightMm = 45
  t('30').sized = true
  const patches = await arrangeDesign(design, { mode: 'layout' })
  for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  assert(Math.abs(t('Ahmed').heightMm - 31) < 0.11 && Math.abs(t('Malek').heightMm - 31) < 0.11, 'LAW 15', `siblings not unified up: ${t('Ahmed').heightMm} / ${t('Malek').heightMm}`)
  assert(Math.abs(t('30').heightMm - 45) < 0.11, 'LAW 15', 'clearly-different number was touched')
  assert(Math.abs(t('Villa').heightMm - 19.1) < 0.11, 'LAW 15', 'label size was touched')
}

/** LAW 16: the name column leads the reading direction (Arabic right, Latin left). */
async function law16ReadingDirection() {
  const sp: TemplateSpec = { finish: 'lighted', layout: 'leftright', w: 400, h: 250, boltDia: 13.4, boltInsetX: 32.8, boltInsetY: 32.8, boltPattern: 'corners', divThick: 2.85 }
  const apply = async (design: Design) => {
    const patches = await arrangeDesign(design, { mode: 'layout' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  }
  // Arabic sign built BACKWARDS (name on the left) must come out name-RIGHT
  const d1 = makeDesign('l16a', signFromSpec(sp), botElements(sp, [['فيلا', '12'], ['احمد', 'العقاد']]))
  await apply(d1)
  const t = (design: Design, txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  const divX1 = d1.elements.find((e) => e.kind === 'divider')!.x
  assert(t(d1, 'احمد').x > divX1 && t(d1, '12').x < divX1, 'LAW 16', `Arabic name not on the right (name x=${t(d1, 'احمد').x}, div=${divX1})`)
  // Latin sign: name stays LEFT
  const d2 = makeDesign('l16b', signFromSpec(sp), botElements(sp, [['Ahmed', 'Malek'], ['Villa', '30']]))
  await apply(d2)
  const divX2 = d2.elements.find((e) => e.kind === 'divider')!.x
  assert(t(d2, 'Ahmed').x < divX2 && t(d2, '30').x > divX2, 'LAW 16', `Latin name not on the left (name x=${t(d2, 'Ahmed').x}, div=${divX2})`)
}

/**
 * LAW 18: the number leads the sign but never dwarfs it (owner 2026-08-27:
 * "dont make numbers super huge just make it look good"). Bot numbers stay
 * within 1.65x the tallest name and 27.5% of the board height (the same
 * PHYSICAL look the judges approved as 1.45x/24% under the old buggy
 * Century Gothic reference metric) - and still above the name, so the
 * number keeps its find-me-first job.
 */
async function law18NumberScale() {
  const cases: { sp: TemplateSpec; groups: string[][] }[] = [
    { sp: { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }, groups: [['م/يحيي', 'اسلام'], ['شقة', '20']] },
    { sp: { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }, groups: [['Villa', '34'], ['المهندس عبيد محمد']] },
    { sp: { finish: 'mirror', layout: 'updown', w: 400, h: 250, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }, groups: [['34'], ['المهندس عبيد محمد']] },
    { sp: { finish: 'mirror', layout: 'leftright', w: 300, h: 150, boltDia: 6.5, boltInsetX: 15.3, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }, groups: [['223'], ['B']] },
  ]
  for (const c of cases) {
    const design = makeDesign('l18', signFromSpec(c.sp), botElements(c.sp, c.groups))
    const patches = await arrangeDesign(design, { mode: 'canonical' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
    const texts = design.elements.filter((e): e is TextEl => e.kind === 'text' && e.text.trim().length > 0)
    const nums = texts.filter((e) => /^[0-9٠-٩\s]+$/.test(e.text.trim()))
    const names = texts.filter((e) => /[؀-ۿa-z]{3,}/i.test(e.text.trim()) && !/^(villa|شقة)$/i.test(e.text.trim()))
    if (nums.length === 0) continue
    const num = Math.max(...nums.map((e) => e.heightMm))
    const label = `LAW 18 @${c.sp.layout} ${c.sp.w}x${c.sp.h}`
    assert(num <= 0.275 * c.sp.h + 0.11, label, `number ${num}mm breaks the 27.5% cap on h=${c.sp.h}`)
    if (names.length > 0) {
      const nameMax = Math.max(...names.map((e) => e.heightMm))
      assert(num <= 1.65 * nameMax + 0.3, label, `number ${num}mm dwarfs the ${nameMax}mm name (>1.65x)`)
      assert(num >= nameMax, label, `number ${num}mm lost the lead to the ${nameMax}mm name`)
    }
  }
}

/**
 * LAW 19: the divider never touches the bolt circles or the text. A side-bolt
 * board pins the divider onto the bolt axis (law 10) - exactly where it could
 * collide, so the engine must clamp its length clear of every hole and keep
 * each half's content inside its half.
 */
async function law19DividerClear() {
  const cases: { sp: TemplateSpec; groups: string[][] }[] = [
    // bolts pulled far inboard: the unclamped content-width divider WOULD hit them
    { sp: { finish: 'mirror', layout: 'updown', w: 300, h: 150, boltDia: 6.5, boltInsetX: 30, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }, groups: [['Villa', '34'], ['عائلة الدرويش الكريمة جدا']] },
    { sp: { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }, groups: [['12'], ['المهندس أحمد', 'عبد الفتاح']] },
    { sp: { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }, groups: [['م/يحيي', 'اسلام'], ['شقة', '20']] },
  ]
  for (const c of cases) {
    const design = makeDesign('l19', signFromSpec(c.sp), botElements(c.sp, c.groups))
    const patches = await arrangeDesign(design, { mode: 'canonical' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
    const label = `LAW 19 @${c.sp.layout} ${c.sp.w}x${c.sp.h}`
    const { texts, div } = await placed(design)
    assert(div !== null, label, 'divider vanished')
    if (!div) continue
    assertDividerClear(design, label, 1)
    // and the text: at least 1mm of air between any line and the divider
    const dl = div.vertical ? div.x - div.thickness / 2 : div.x - div.length / 2
    const dr = div.vertical ? div.x + div.thickness / 2 : div.x + div.length / 2
    const dt = div.vertical ? div.y - div.length / 2 : div.y - div.thickness / 2
    const db = div.vertical ? div.y + div.length / 2 : div.y + div.thickness / 2
    for (const t of texts) {
      const gapX = Math.max(dl - t.right, t.left - dr)
      const gapY = Math.max(dt - t.bottom, t.top - db)
      assert(Math.max(gapX, gapY) >= 1, label, `"${t.el.text}" is ${Math.max(gapX, gapY).toFixed(1)}mm from the divider (needs >= 1)`)
    }
  }
}

/**
 * LAW 20: the villa row huddles (owner 2026-08-27: "sometimes we need to get
 * the 34 and villa closer to each other"). A short label|number pair is not
 * flung to the board edges - the middle gap is capped at 12% of board width
 * (3-judge render panel, unanimous: the gap must read as a word-space, smaller
 * than the flanking margins, so the pair groups by proximity) and the pair
 * stays centered as a group. Long pairs still justify to the content width,
 * and the number keeps its side.
 */
async function law20RowHuddle() {
  const MAXGAP = 0.12
  const sp: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('l20', signFromSpec(sp), botElements(sp, [['فيلا', '34'], ['المهندس عبيد محمد']]))
  const patches = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  const label = 'LAW 20 فيلا/34'
  const { texts } = await placed(design)
  const num = texts.find((t) => t.el.text === '34')!
  const lab = texts.find((t) => t.el.text === 'فيلا')!
  // Arabic label keeps the right side, the number the left
  assert(num.el.x < lab.el.x, label, `number/label sides flipped (num x=${num.el.x}, label x=${lab.el.x})`)
  const gap = lab.left - num.right
  assert(gap <= MAXGAP * sp.w + 1, label, `pair still flung apart: ${gap.toFixed(0)}mm gap (cap ${MAXGAP * sp.w}mm)`)
  assert(gap >= 0.05 * sp.w, label, `pair crammed together: ${gap.toFixed(0)}mm gap`)
  // the pair is centered as a group on the board
  const mid = (num.left + lab.right) / 2
  assert(Math.abs(mid - sp.w / 2) <= 0.015 * sp.w, label, `huddled pair off-center: ${mid.toFixed(1)} vs ${sp.w / 2}`)
  // and the divider still spans the widest content (the name below), never less
  const d = design.elements.find((e) => e.kind === 'divider')
  const name = texts.find((t) => t.el.text.includes('المهندس'))!
  if (d && d.kind === 'divider') {
    assert(d.length >= name.right - name.left - 1, label, `divider shorter than the name below: ${d.length} vs ${(name.right - name.left).toFixed(0)}`)
  }
}

/** LAW 17: "Ahmed Ali" in a narrow LR column splits into AHMED over ALI when bigger. */
async function law17NameSplit() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 300, h: 150, boltDia: 6.5, boltInsetX: 15.3, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }
  const base = makeDesign('l17', signFromSpec(sp), botElements(sp, [['Ahmed Ali'], ['Villa', '30']]))
  const baseNameId = base.elements.find((e): e is TextEl => e.kind === 'text' && e.text === 'Ahmed Ali')!.id
  const basePatches = await arrangeDesign(JSON.parse(JSON.stringify(base)), { mode: 'canonical' })
  const singleH = basePatches[baseNameId]?.heightMm ?? 999
  const optimized = await optimizeNameSplits(base)
  const texts = optimized.elements.filter((e): e is TextEl => e.kind === 'text').map((e) => e.text)
  assert(texts.includes('Ahmed') && texts.includes('Ali'), 'LAW 17', `name not split: ${texts.join(' | ')}`)
  const patches = await arrangeDesign(optimized, { mode: 'canonical' })
  const ahmed = optimized.elements.find((e): e is TextEl => e.kind === 'text' && e.text === 'Ahmed')!
  const hSplit = patches[ahmed.id]?.heightMm ?? 0
  assert(hSplit >= singleH - 0.11, 'LAW 17', `split made the name smaller: ${hSplit} vs single ${singleH}`)
  // a column that already has two name lines is never split further
  const two = makeDesign('l17b', signFromSpec(sp), botElements(sp, [['أ / محروس', 'عبد الحميد'], ['منيل', 'جويدة']]))
  const untouched = await optimizeNameSplits(two)
  assert(untouched.elements.filter((e) => e.kind === 'text').length === 4, 'LAW 17', 'already-stacked names were split again')
}

/**
 * MANUAL SPACING IS SOVEREIGN (owner 2026-08-27, final Perfect-it contract:
 * "does not change the layout - i do it... dont make it make spacing - i do
 * it manually - it just aligns and makes sure the sign have no errors"):
 * Perfect-it never re-spaces a gap the user made. Vertical gaps survive the
 * button EXACTLY; only alignment (shared X), error fixes and the law-21
 * group-centering translation are allowed to move anything.
 */
async function manualSpacingSovereign() {
  const label = 'MANUAL SPACING'
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85, radius: 2.5 }
  const design = makeDesign('spc', signFromSpec(sp), botElements(sp, [['م/يحيي', 'اسلام'], ['شقة', '20']]))
  const t = (txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  const apply = async () => {
    const patches = await arrangeDesign(design, { mode: 'layout' })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  }
  const p0 = await arrangeDesign(design, { mode: 'canonical' })
  for (const el of design.elements) Object.assign(el, p0[el.id] ?? {})
  // the user opens the name gap wide and tightens the label onto its number -
  // BOTH custom gaps must survive Perfect-it to the tenth of a millimetre
  t('اسلام').y += 17
  t('شقة').y += 6
  const gapNames = t('اسلام').y - t('م/يحيي').y
  const gapLabel = t('20').y - t('شقة').y
  await apply()
  assert(Math.abs(t('اسلام').y - t('م/يحيي').y - gapNames) < 0.11, label, `name gap re-spaced: ${(t('اسلام').y - t('م/يحيي').y).toFixed(1)} vs ${gapNames.toFixed(1)}`)
  assert(Math.abs(t('20').y - t('شقة').y - gapLabel) < 0.11, label, `label gap re-spaced: ${(t('20').y - t('شقة').y).toFixed(1)} vs ${gapLabel.toFixed(1)}`)
  // alignment still happened
  assert(Math.abs(t('م/يحيي').x - t('اسلام').x) < 0.11, label, 'column lost its shared X')
  // and hammering the button changes nothing
  const snap = design.elements.map((e) => [e.x, e.y] as const)
  await apply()
  design.elements.forEach((e, i) => assert(Math.abs(e.x - snap[i][0]) <= 0.15 && Math.abs(e.y - snap[i][1]) <= 0.15, label, `not idempotent: el ${i}`))
}

/**
 * LAW 22 (owner 2026-08-27: "IT CANNOT NEVER EVER LETTERS DIVIDER HIT THE
 * BOLTS"): letters keep clear of every bolt hole in both modes - the solver
 * fills between the bolts, and Perfect-it pushes a hand-dragged block off a
 * bolt instead of leaving the collision.
 */
async function law22BoltClearance() {
  const label = 'LAW 22'
  // the owner's screenshot case: Lighted UD 40x25 - big corner bolts, wide name
  const lighted = templateCatalog.find((t) => t.finish === 'lighted' && t.layout === 'updown' && t.w === 400)!
  const d1 = makeDesign('l22', signFromSpec(lighted), botElements(lighted, [['المهندس عبيد محمد'], ['Villa', '34']]))
  const p1 = await arrangeDesign(d1, { mode: 'canonical' })
  for (const el of d1.elements) Object.assign(el, p1[el.id] ?? {})
  await assertTextClearOfBolts(d1, `${label} bot lighted`, 1.5)

  // drag the name straight onto the top bolts - Perfect-it must push it clear
  for (const el of d1.elements) if (el.kind === 'text' && el.text.includes('المهندس')) el.y = lighted.boltInsetY
  const p2 = await arrangeDesign(d1, { mode: 'layout' })
  for (const el of d1.elements) Object.assign(el, p2[el.id] ?? {})
  await assertTextClearOfBolts(d1, `${label} dragged-onto-bolts`, 1.5)

  // the panel's critical: stock template seeds on the PINNED vertical board,
  // straight into Perfect-it - the pinned line must never cross a letter
  const pinnedSpec = templateCatalog.find((t) => t.boltPattern === 'sides' && t.h > t.w)!
  const d2 = makeFromSpec(pinnedSpec)
  const p3 = await arrangeDesign(d2, { mode: 'layout' })
  for (const el of d2.elements) Object.assign(el, p3[el.id] ?? {})
  const { texts: t2, div: div2 } = await placed(d2)
  assert(div2 !== null, label, 'pinned board lost its divider')
  if (div2) {
    assert(Math.abs(div2.y - pinnedSpec.h / 2) < 0.11, label, `pinned line moved: y=${div2.y}`)
    for (const t of t2) {
      const overlapY = Math.min(t.bottom, div2.y + div2.thickness / 2) - Math.max(t.top, div2.y - div2.thickness / 2)
      const overlapX = Math.min(t.right, div2.x + div2.length / 2) - Math.max(t.left, div2.x - div2.length / 2)
      assert(!(overlapX > 0.5 && overlapY > 0), label, `pinned line cuts through "${t.el.text}" (template->perfect flow)`)
    }
  }
  await assertTextClearOfBolts(d2, `${label} pinned template`, 1.5)
  // and hammering the button stays stable
  const snap = d2.elements.map((e) => [e.x, e.y] as const)
  const p4 = await arrangeDesign(d2, { mode: 'layout' })
  for (const el of d2.elements) Object.assign(el, p4[el.id] ?? {})
  d2.elements.forEach((e, i) => assert(Math.abs(e.x - snap[i][0]) <= 0.2 && Math.abs(e.y - snap[i][1]) <= 0.2, label, `pinned board not idempotent: el ${i}`))
}

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  setFontDataProvider(async (id) => {
    const file = FONT_FILES[id]
    if (!file) throw new Error(`no font file for ${id}`)
    return readFileSync(join(root, file)).buffer as ArrayBuffer
  })
  for (const c of CASES) {
    for (const [w, h] of BOARDS[c.layout]) {
      await runCase(c, w, h)
    }
  }
  await goldenMaster()
  await sizingSovereignty()
  await perfectItCleanup()
  await boltAxisLaw()
  await law11BigText()
  await alignmentLaws()
  await law14CrossAxis()
  await law15SiblingSizes()
  await law16ReadingDirection()
  await law17NameSplit()
  await law18NumberScale()
  await law19DividerClear()
  await law20RowHuddle()
  await law22BoltClearance()
  await manualSpacingSovereign()
  console.log(`\n${checks} checks, ${failures} failures across ${CASES.length} text cases x 3 board sizes`)
  if (failures > 0) process.exit(1)
  console.log('layout engine: ALL GREEN')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
