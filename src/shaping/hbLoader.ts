// Browser-only bootstrap: fetch the HarfBuzz wasm via Vite and initialise the engine.
import wasmUrl from 'harfbuzzjs/hb.wasm?url'
import { initHB } from './engine'

let boot: Promise<void> | null = null

export function bootHB(): Promise<void> {
  if (!boot) {
    boot = fetch(wasmUrl)
      .then((r) => r.arrayBuffer())
      .then((bytes) => initHB(bytes))
  }
  return boot
}
