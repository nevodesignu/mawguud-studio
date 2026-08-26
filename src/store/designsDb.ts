import { createStore, get, set, del, values } from 'idb-keyval'
import type { Design } from '../model'

const db = createStore('mawguud-designs', 'designs')

export interface DesignMeta {
  id: string
  name: string
  updatedAt: number
  size: string
}

export async function saveDesign(design: Design): Promise<void> {
  await set(design.id, design, db)
}

export async function loadDesignById(id: string): Promise<Design | undefined> {
  return get<Design>(id, db)
}

export async function deleteDesignById(id: string): Promise<void> {
  await del(id, db)
}

export async function listDesigns(): Promise<DesignMeta[]> {
  const all = (await values(db)) as Design[]
  return all
    .map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt,
      size: `${(d.sign.w / 10).toFixed(0)}×${(d.sign.h / 10).toFixed(0)}cm`,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
