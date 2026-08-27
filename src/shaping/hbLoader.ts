// Browser-only bootstrap: fetch the HarfBuzz wasm via Vite and initialise the engine.
import wasmUrl from 'harfbuzzjs/hb.wasm?url'
import { initHB } from './engine'

let boot: Promise<void> | null = null

export function bootHB(): Promise<void> {
  if (!boot) {
    boot = fetch(wasmUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`hb.wasm fetch failed: ${r.status}`)
        return r.arrayBuffer()
      })
      .then((bytes) => initHB(bytes))
      .catch((err) => {
        console.error('HarfBuzz boot failed', err)
        boot = null // allow retry instead of caching the failure forever
        throw err
      })
  }
  return boot
}
