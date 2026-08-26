import type { MultiPoly } from '../geom/types'
import { multiToD } from '../geom/poly'
import type { AiDocInput } from './pdf'

/** Production SVG twin of the .ai file - mm units, 1:1. */
export function buildProductionSvg({ wMm, hMm, cutLines, shapes }: AiDocInput): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wMm}mm" height="${hMm}mm" viewBox="0 0 ${wMm} ${hMm}">` +
    `<path d="${multiToD(cutLines)}" fill="none" stroke="#ff0000" stroke-width="0.05"/>` +
    `<path d="${multiToD(shapes)}" fill="#000" fill-rule="evenodd" stroke="#ff0000" stroke-width="0.05"/>` +
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
