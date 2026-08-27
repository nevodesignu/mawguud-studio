// Font catalog: built-ins ship in public/fonts; uploaded fonts are stored as
// real files on disk via the dev server (/api/fonts -> public/fonts/user/).
export interface FontMeta {
  id: string
  name: string
  builtin: boolean
}

export const builtinFonts: (FontMeta & { url: string })[] = [
  { id: 'avenir-arabic-medium', name: 'Avenir Arabic Medium ★ production', builtin: true, url: '/fonts/AvenirArabic-Medium.otf' },
  { id: 'century-gothic-bold', name: 'Century Gothic Bold', builtin: true, url: '/fonts/CenturyGothic-Bold.ttf' },
  { id: 'century-gothic', name: 'Century Gothic', builtin: true, url: '/fonts/CenturyGothic-Regular.ttf' },
  { id: 'amiri-bold', name: 'Amiri Bold (naskh)', builtin: true, url: '/fonts/Amiri-Bold.ttf' },
  { id: 'tajawal-bold', name: 'Tajawal Bold', builtin: true, url: '/fonts/Tajawal-Bold.ttf' },
  { id: 'almarai-bold', name: 'Almarai Bold', builtin: true, url: '/fonts/Almarai-Bold.ttf' },
  { id: 'poppins-bold', name: 'Poppins Bold (Latin)', builtin: true, url: '/fonts/Poppins-Bold.ttf' },
]

// Headless environments (the layout test battery) inject their own font loader
let fontDataProvider: ((id: string) => Promise<ArrayBuffer>) | null = null
export function setFontDataProvider(p: (id: string) => Promise<ArrayBuffer>): void {
  fontDataProvider = p
}

const USER_PREFIX = 'user:'
const fileOf = (id: string) => id.slice(USER_PREFIX.length)
const nameOf = (file: string) => file.replace(/\.(ttf|otf)$/i, '').replace(/_+/g, ' ')

export async function listUploadedFonts(): Promise<FontMeta[]> {
  try {
    const res = await fetch('/api/fonts')
    if (!res.ok) return []
    const files = (await res.json()) as string[]
    return files.map((f) => ({ id: USER_PREFIX + f, name: nameOf(f), builtin: false })).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export async function addUploadedFont(file: File): Promise<FontMeta> {
  const safe = file.name.replace(/[^\w.-]+/g, '_')
  const res = await fetch(`/api/fonts/${encodeURIComponent(safe)}`, { method: 'POST', body: await file.arrayBuffer() })
  if (!res.ok) throw new Error('font upload failed')
  return { id: USER_PREFIX + safe, name: nameOf(safe), builtin: false }
}

export async function removeUploadedFont(id: string): Promise<void> {
  await fetch(`/api/fonts/${encodeURIComponent(fileOf(id))}`, { method: 'DELETE' })
}

export async function getFontData(id: string): Promise<ArrayBuffer> {
  if (fontDataProvider) return fontDataProvider(id)
  const builtin = builtinFonts.find((f) => f.id === id)
  const url = builtin ? builtin.url : id.startsWith(USER_PREFIX) ? `/fonts/user/${encodeURIComponent(fileOf(id))}` : null
  if (!url) throw new Error(`font not found: ${id}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`font fetch failed: ${url}`)
  return res.arrayBuffer()
}
