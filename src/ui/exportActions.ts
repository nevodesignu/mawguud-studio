// Assemble production/preview documents from a design and trigger downloads.
import type { Design } from '../model'
import { boltCenters } from '../model'
import type { FinalizeResult } from '../store/studio'
import type { MultiPoly } from '../geom/types'
import { roundedRectRing, circleRing, multiToD, barRing } from '../geom/poly'
import { buildAiPdf, MAWGUUD_STYLE, REDLINE_STYLE, type AiDocInput } from '../export/pdf'
import { buildProductionSvg, saveBlob } from '../export/svg'
import { shapedAsync } from '../shaping/service'
import { renderTextEl } from './textRender'

export function cutLinesOf(design: Design): MultiPoly {
  const { sign } = design
  const cut: MultiPoly = [[roundedRectRing(0, 0, sign.w, sign.h, sign.radius)]]
  for (const [x, y] of boltCenters(sign)) {
    cut.push([circleRing(x, y, sign.boltDia / 2)])
  }
  return cut
}

export function productionDoc(design: Design, fin: FinalizeResult): AiDocInput {
  // fin.geometry is already the true production shape (welded THEN bridged) -
  // no boolean work may happen after bridging or tabs could be sealed shut
  return {
    wMm: design.sign.w,
    hMm: design.sign.h,
    cutLines: cutLinesOf(design),
    shapes: fin.geometry,
    style: design.fin.exportStyle === 'redline' ? REDLINE_STYLE : MAWGUUD_STYLE,
  }
}

const fmtCm = (mm: number) => String(Math.round(mm) / 10)

export function exportFilename(design: Design, ext: string): string {
  const base = design.name.replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '-') || 'sign'
  return `${base}-${fmtCm(design.sign.w)}x${fmtCm(design.sign.h)}cm.${ext}`
}

export function downloadAi(design: Design, fin: FinalizeResult): void {
  const bytes = buildAiPdf(productionDoc(design, fin))
  saveBlob(bytes, exportFilename(design, 'ai'), 'application/pdf')
}

export function downloadPdf(design: Design, fin: FinalizeResult): void {
  const bytes = buildAiPdf(productionDoc(design, fin))
  saveBlob(bytes, exportFilename(design, 'pdf'), 'application/pdf')
}

export function downloadProductionSvg(design: Design, fin: FinalizeResult): void {
  saveBlob(buildProductionSvg(productionDoc(design, fin)), exportFilename(design, 'svg'), 'image/svg+xml')
}

/** Phase-1 client preview: clean black & white, no bridges. */
export async function downloadClientPng(design: Design): Promise<void> {
  try {
    await clientPngInner(design)
  } catch (err) {
    console.error(err)
    alert('Client preview export failed: ' + (err instanceof Error ? err.message : String(err)))
  }
}

async function clientPngInner(design: Design): Promise<void> {
  const { sign } = design
  const parts: string[] = []
  for (const el of design.elements) {
    if (el.kind === 'text') {
      const shaped = await shapedAsync(el.fontId, el.text, el.spacingEm)
      const r = renderTextEl(el, shaped)
      if (r) parts.push(`<g transform="${r.transform}"><path d="${r.d}" fill="#000000"/></g>`)
    } else {
      const ring = barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)
      parts.push(`<path d="${multiToD([[ring]])}" fill="#000000"/>`)
    }
  }
  const outline = multiToD([[roundedRectRing(0, 0, sign.w, sign.h, sign.radius)]])
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sign.w}mm" height="${sign.h}mm" viewBox="0 0 ${sign.w} ${sign.h}">` +
    `<rect width="${sign.w}" height="${sign.h}" fill="#ffffff"/>` +
    `<path d="${outline}" fill="none" stroke="#c9c9c9" stroke-width="0.6"/>` +
    parts.join('') +
    `</svg>`

  const pxW = 2000
  const pxH = Math.round((pxW * sign.h) / sign.w)
  const img = new Image()
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('preview render failed'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = pxW
  canvas.height = pxH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pxW, pxH)
  ctx.drawImage(img, 0, 0, pxW, pxH)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('the browser could not encode the PNG')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  saveBlob(bytes, exportFilename(design, 'png'), 'image/png')
}
