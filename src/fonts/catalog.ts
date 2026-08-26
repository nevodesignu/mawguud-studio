import { createStore, get, set, del, keys } from 'idb-keyval'

export interface FontMeta {
  id: string
  name: string
  builtin: boolean
}

export const builtinFonts: (FontMeta & { url: string })[] = [
  { id: 'amiri-bold', name: 'Amiri Bold (naskh)', builtin: true, url: '/fonts/Amiri-Bold.ttf' },
  { id: 'tajawal-bold', name: 'Tajawal Bold', builtin: true, url: '/fonts/Tajawal-Bold.ttf' },
  { id: 'almarai-bold', name: 'Almarai Bold', builtin: true, url: '/fonts/Almarai-Bold.ttf' },
  { id: 'poppins-bold', name: 'Poppins Bold (Latin)', builtin: true, url: '/fonts/Poppins-Bold.ttf' },
]

const fontStore = createStore('mawguud-fonts', 'fonts')

interface StoredFont {
  name: string
  data: ArrayBuffer
}

export async function listUploadedFonts(): Promise<FontMeta[]> {
  const ids = (await keys(fontStore)) as string[]
  const metas: FontMeta[] = []
  for (const id of ids) {
    const rec = (await get<StoredFont>(id, fontStore))!
    metas.push({ id, name: rec.name, builtin: false })
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name))
}

export async function addUploadedFont(file: File): Promise<FontMeta> {
  const data = await file.arrayBuffer()
  const name = file.name.replace(/\.(ttf|otf)$/i, '')
  const id = `user-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`
  await set(id, { name, data } satisfies StoredFont, fontStore)
  return { id, name, builtin: false }
}

export async function removeUploadedFont(id: string): Promise<void> {
  await del(id, fontStore)
}

export async function getFontData(id: string): Promise<ArrayBuffer> {
  const builtin = builtinFonts.find((f) => f.id === id)
  if (builtin) {
    const res = await fetch(builtin.url)
    if (!res.ok) throw new Error(`font fetch failed: ${builtin.url}`)
    return res.arrayBuffer()
  }
  const rec = await get<StoredFont>(id, fontStore)
  if (!rec) throw new Error(`font not found: ${id}`)
  return rec.data
}
