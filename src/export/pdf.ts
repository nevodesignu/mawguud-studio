// PDF-compatible .ai writer. 1:1 scale: the page is exactly the sign size in mm.
// Default style matches Mawguud's own production templates (measured from their
// .ai files): everything in near-black #231F20, 1pt strokes, letter shapes
// filled. A red-hairline style is available for laser softwares that expect it.
// Input geometry is design space (mm, y-down); this writer flips to PDF y-up.
import type { MultiPoly } from '../geom/types'

const MM = 72 / 25.4

export interface AiStyle {
  cutColor: [number, number, number] // 0-255
  cutWidthMm: number
  shapeFill: [number, number, number]
  shapeStrokeWidthMm: number
}

// pure black at 1pt (the templates measured #231F20, but the boss says #000000)
export const MAWGUUD_STYLE: AiStyle = { cutColor: [0, 0, 0], cutWidthMm: 0.353, shapeFill: [0, 0, 0], shapeStrokeWidthMm: 0.353 }
// hairline red cut-line convention used by many laser workflows
export const REDLINE_STYLE: AiStyle = { cutColor: [255, 0, 0], cutWidthMm: 0.02, shapeFill: [0, 0, 0], shapeStrokeWidthMm: 0.02 }

const frac = (c: number) => (c / 255).toFixed(4)

function pathOps(mp: MultiPoly, hMm: number): string {
  const ops: string[] = []
  for (const poly of mp) {
    for (const ring of poly) {
      if (ring.length < 3) continue
      ops.push(`${ring[0][0].toFixed(3)} ${(hMm - ring[0][1]).toFixed(3)} m`)
      for (let i = 1; i < ring.length; i++) {
        ops.push(`${ring[i][0].toFixed(3)} ${(hMm - ring[i][1]).toFixed(3)} l`)
      }
      ops.push('h')
    }
  }
  return ops.join('\n')
}

export interface AiDocInput {
  wMm: number
  hMm: number
  cutLines: MultiPoly // stroked only (panel outline, bolt holes)
  shapes: MultiPoly // filled + stroked (letters, dividers) - even-odd fill
  style?: AiStyle
}

export function buildAiPdf({ wMm, hMm, cutLines, shapes, style = MAWGUUD_STYLE }: AiDocInput): Uint8Array {
  const [cr, cg, cb] = style.cutColor
  const [fr, fg, fb] = style.shapeFill
  const content = [
    'q',
    `${MM.toFixed(8)} 0 0 ${MM.toFixed(8)} 0 0 cm`,
    `${frac(cr)} ${frac(cg)} ${frac(cb)} RG ${style.cutWidthMm.toFixed(3)} w`,
    pathOps(cutLines, hMm),
    'S',
    `${frac(fr)} ${frac(fg)} ${frac(fb)} rg ${frac(cr)} ${frac(cg)} ${frac(cb)} RG ${style.shapeStrokeWidthMm.toFixed(3)} w`,
    pathOps(shapes, hMm),
    'B*',
    'Q',
  ].join('\n')

  const enc = new TextEncoder()
  const contentBytes = enc.encode(content)

  const objs: Uint8Array[] = [
    enc.encode('<< /Type /Catalog /Pages 2 0 R >>'),
    enc.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    enc.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(wMm * MM).toFixed(3)} ${(hMm * MM).toFixed(3)}] /Contents 4 0 R /Resources << >> >>`,
    ),
    concat([enc.encode(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, enc.encode('\nendstream')]),
  ]

  const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]
  let size = chunks[0].length + chunks[1].length
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(size)
    const head = enc.encode(`${i + 1} 0 obj\n`)
    const tail = enc.encode('\nendobj\n')
    chunks.push(head, body, tail)
    size += head.length + body.length + tail.length
  })
  const startxref = size
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`
  chunks.push(enc.encode(xref))
  return concat(chunks)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
