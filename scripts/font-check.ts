// Sanity-check a font file against the app's real shaping pipeline.
// Run: npx tsx scripts/font-check.ts public/fonts/AvenirArabic-Medium.otf "text"
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initHB, loadFont, shapeLine } from '../src/shaping/engine'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  await initHB(readFileSync(join(root, 'node_modules/harfbuzzjs/hb.wasm')))
  const file = process.argv[2]
  const font = loadFont('probe', readFileSync(join(root, file)).buffer as ArrayBuffer)
  for (const text of process.argv.slice(3)) {
    const shaped = shapeLine(font, text, 0)
    const w = shaped.bbox.maxX - shaped.bbox.minX
    const h = shaped.bbox.maxY - shaped.bbox.minY
    const empty = shaped.glyphs.filter((g) => g.cmds.length === 0).length
    console.log(
      `"${text}" -> glyphs=${shaped.glyphs.length} emptyPaths=${empty} ink=${w > 0 && h > 0 ? (w / font.upem).toFixed(2) + 'em x ' + (h / font.upem).toFixed(2) + 'em' : 'NONE'}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
