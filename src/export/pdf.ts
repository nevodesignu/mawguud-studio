// PDF-compatible .ai writer. 1:1 scale: the page is exactly the sign size in mm.
// Cut lines are hairline red strokes; solid shapes are black fill + hairline red
// stroke so any laser-software import convention finds usable vectors.
// Input geometry is design space (mm, y-down); this writer flips to PDF y-up.
import type { MultiPoly } from '../geom/types'

const MM = 72 / 25.4

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
  cutLines: MultiPoly // stroked hairline red only (panel outline, mounting holes)
  shapes: MultiPoly // filled black + hairline red (letters, dividers) - even-odd fill
}

export function buildAiPdf({ wMm, hMm, cutLines, shapes }: AiDocInput): Uint8Array {
  const content = [
    'q',
    `${MM.toFixed(8)} 0 0 ${MM.toFixed(8)} 0 0 cm`,
    '1 0 0 RG 0.01 w',
    pathOps(cutLines, hMm),
    'S',
    '0 0 0 rg 1 0 0 RG 0.01 w',
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
