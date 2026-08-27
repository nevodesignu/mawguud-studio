import { multiToD } from '../geom/poly'
import { MAWGUUD_STYLE, type AiDocInput } from './pdf'

const hex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

/** Production SVG twin of the .ai file - mm units, 1:1. */
export function buildProductionSvg({ wMm, hMm, cutLines, shapes, style = MAWGUUD_STYLE }: AiDocInput): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wMm}mm" height="${hMm}mm" viewBox="0 0 ${wMm} ${hMm}">` +
    `<path d="${multiToD(cutLines)}" fill="none" stroke="${hex(style.cutColor)}" stroke-width="${style.cutWidthMm}"/>` +
    `<path d="${multiToD(shapes)}" fill="${hex(style.shapeFill)}" fill-rule="evenodd" stroke="${hex(style.cutColor)}" stroke-width="${style.shapeStrokeWidthMm}"/>` +
    `</svg>`
  )
}

export function saveBlob(data: Uint8Array | string, filename: string, mime: string): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
