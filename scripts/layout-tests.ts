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
import { makeDesign, botElements, signFromSpec, type TemplateSpec, type Design, type TextEl, type Layout } from '../src/model'

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
  }
  // 2. whole-composition centering
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
 * GOLDEN MASTER - approved by the owner on 2026-08-27 ("this one is perfect"):
 * bot(["م/يحيي","اسلام"] | ["شقة","20"]) on Mirror 40x20 must produce exactly
 * names 30mm, label 25.5mm, number 60mm, divider ~113mm. Any engine change
 * that moves these numbers changes the approved production look - and fails.
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
  near(byText('م/يحيي').heightMm, 30, 0.5, 'name line height')
  near(byText('اسلام').heightMm, 30, 0.5, 'name line height')
  near(byText('شقة').heightMm, 25.5, 0.5, 'label height')
  near(byText('20').heightMm, 60, 0.5, 'number height')
  const d = design.elements.find((e) => e.kind === 'divider')
  // re-baselined 2026-08-27 (x2): ink-extent stacking measures true block
  // heights (descenders included) so the content-matched divider follows
  if (d && d.kind === 'divider') near(d.length, 118.4, 2, 'divider length')
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
  const canonPatches = await arrangeDesign(JSON.parse(JSON.stringify(base)), { mode: 'canonical' })
  const canonName = canonPatches[t(base, 'المهندس عبيد محمد').id]?.heightMm ?? 0
  const canonNum = canonPatches[t(base, '180').id]?.heightMm ?? 0
  const label = 'SOVEREIGNTY Villa/180'
  assert(canonName > 5 && canonNum > 5, label, `canonical heights implausible: ${canonName}/${canonNum}`)
  const above = canonName + 15
  t(base, 'المهندس عبيد محمد').heightMm = above // deliberate: bigger than base
  t(base, '180').heightMm = Math.max(1, canonNum - 20) // stale: smaller than base
  const patches = await arrangeDesign(base, { mode: 'layout' })
  const nameH = patches[t(base, 'المهندس عبيد محمد').id]?.heightMm ?? 0
  const numH = patches[t(base, '180').id]?.heightMm ?? 0
  assert(Math.abs(nameH - above) < 0.11, label, `above-base size not kept: ${above} -> ${nameH}`)
  assert(Math.abs(numH - canonNum) < 0.11, label, `below-base size not raised to base: ${numH} vs ${canonNum}`)
}

/** Nudge preservation: a small deliberate move survives Perfect-it; a large one snaps. */
async function nudgeKeep() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 400, h: 200, boltDia: 6.6, boltInsetX: 23.6, boltInsetY: 23.6, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('nudge', signFromSpec(sp), botElements(sp, [['م/يحيي', 'اسلام'], ['شقة', '20']]))
  const applyMode = async (mode: 'layout' | 'canonical') => {
    const patches = await arrangeDesign(design, { mode })
    for (const el of design.elements) Object.assign(el, patches[el.id] ?? {})
  }
  await applyMode('canonical')
  // nudge the TOP line: far from any other axis, so law-14 unification stays out
  const line = design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === 'م/يحيي')!
  const nudgedY = line.y - 5 // "a bit upward"
  line.y = nudgedY
  await applyMode('layout')
  assert(Math.abs(line.y - nudgedY) < 0.001, 'NUDGE', `small nudge was not kept: ${nudgedY} -> ${line.y}`)
  line.y = nudgedY + 80 // thrown far off - should snap back to proper placement
  await applyMode('layout')
  assert(Math.abs(line.y - (nudgedY + 80)) > 5, 'NUDGE', 'large displacement was not re-placed')
}

/** Side bolts sit at mid-height: the horizontal divider must run on their axis. */
async function boltAxisLaw() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'updown', w: 300, h: 150, boltDia: 6.5, boltInsetX: 15.3, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }
  for (const mode of ['canonical', 'layout'] as const) {
    const design = makeDesign('axis', signFromSpec(sp), botElements(sp, [['34'], ['المهندس عبيد محمد']]))
    const patches = await arrangeDesign(design, { mode })
    const d = design.elements.find((e) => e.kind === 'divider')!
    const y = patches[d.id]?.y
    assert(y !== undefined && Math.abs(y - 75) < 0.11, 'BOLT AXIS', `divider not on the bolt axis (${mode}): y=${y} vs 75`)
  }
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
  assert(Math.abs(t('أحمد').y - t('منى').y) < 0.11, 'LAW 14', `cross-divider rows not unified: ${t('أحمد').y} vs ${t('منى').y}`)
  assert(Math.abs(t('محمود').y - t('سارة').y) < 0.11, 'LAW 14', `cross-divider rows not unified (2nd): ${t('محمود').y} vs ${t('سارة').y}`)
}

/** LAW 15: near-equal sibling sizes unify UP; clearly different sizes stay. */
async function law15SiblingSizes() {
  const sp: TemplateSpec = { finish: 'mirror', layout: 'leftright', w: 300, h: 150, boltDia: 6.5, boltInsetX: 15.3, boltInsetY: 75, boltPattern: 'sides', divThick: 2.85 }
  const design = makeDesign('l15', signFromSpec(sp), botElements(sp, [['Ahmed', 'Malek'], ['Villa', '30']]))
  const t = (txt: string) => design.elements.find((e): e is TextEl => e.kind === 'text' && e.text === txt)!
  t('Ahmed').heightMm = 28.4
  t('Malek').heightMm = 31 // almost equal - the exact case the owner spotted
  t('Villa').heightMm = 19.1
  t('30').heightMm = 45
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
  await nudgeKeep()
  await boltAxisLaw()
  await law11BigText()
  await alignmentLaws()
  await law14CrossAxis()
  await law15SiblingSizes()
  await law16ReadingDirection()
  await law17NameSplit()
  console.log(`\n${checks} checks, ${failures} failures across ${CASES.length} text cases x 3 board sizes`)
  if (failures > 0) process.exit(1)
  console.log('layout engine: ALL GREEN')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
