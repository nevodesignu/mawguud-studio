// Designs persist as real JSON files on disk via the dev server (/api/designs).
// Browser storage is NOT trusted - embedded preview panes can wipe it anytime.
import type { Design } from '../model'

export interface DesignMeta {
  id: string
  name: string
  updatedAt: number
  size: string
}

export async function saveDesign(design: Design): Promise<void> {
  await fetch(`/api/designs/${design.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(design),
  })
}

export async function loadDesignById(id: string): Promise<Design | undefined> {
  const res = await fetch(`/api/designs/${id}`)
  if (!res.ok) return undefined
  return (await res.json()) as Design
}

export async function deleteDesignById(id: string): Promise<void> {
  await fetch(`/api/designs/${id}`, { method: 'DELETE' })
}

export async function listDesigns(): Promise<DesignMeta[]> {
  const res = await fetch('/api/designs')
  if (!res.ok) return []
  const all = (await res.json()) as Design[]
  return all
    .map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt,
      size: `${(d.sign.w / 10).toFixed(0)}×${(d.sign.h / 10).toFixed(0)}cm`,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
