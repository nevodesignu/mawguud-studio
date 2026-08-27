// Sign Bot: pick a product + size, type the text, get a perfectly laid-out
// sign in one shot (build -> auto-arrange). Deterministic, instant.
import { useState } from 'react'
import { useStudio } from '../store/studio'
import { templateCatalog, finishLabel, layoutLabel, type Finish, type Layout, type TemplateSpec } from '../model'

export function SignBot({ onClose }: { onClose: () => void }) {
  const [finish, setFinish] = useState<Finish>('lighted')
  const [layout, setLayout] = useState<Layout>('leftright')
  const sizes = templateCatalog.filter((t) => t.finish === finish && t.layout === layout)
  const [sizeIdx, setSizeIdx] = useState(0)
  const [primary, setPrimary] = useState<string[]>(['أ / محمد', 'عبد الحميد'])
  const [secondary, setSecondary] = useState<string[]>(['فيلا', '25'])
  const [busy, setBusy] = useState(false)

  const spec: TemplateSpec = sizes[Math.min(sizeIdx, sizes.length - 1)]
  const isLR = layout === 'leftright'
  const primaryLabel = isLR ? 'Right of divider (the name)' : layout === 'updown' ? 'Top (usually the number)' : 'Top (the number)'
  const secondaryLabel = isLR ? 'Left of divider' : 'Bottom (the name)'

  const make = async () => {
    setBusy(true)
    try {
      await useStudio.getState().createFromBot(spec, [primary, secondary])
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const lineEditor = (lines: string[], setLines: (l: string[]) => void) => (
    <div className="stack">
      {lines.map((line, i) => (
        <div className="bot-line" key={i}>
          <input
            dir="auto"
            value={line}
            placeholder="type a line…"
            onChange={(e) => setLines(lines.map((l, j) => (j === i ? e.target.value : l)))}
          />
          <button className="icon" title="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button onClick={() => setLines([...lines, ''])}>+ line</button>
    </div>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🤖 Sign Bot</h2>
        <p className="hint">Pick the product, type the text — the bot builds the sign with everything perfectly centered and sized.</p>
        <div className="tabs">
          {(['lighted', 'mirror'] as Finish[]).map((f) => (
            <button key={f} className={finish === f ? 'tab active' : 'tab'} onClick={() => { setFinish(f); setSizeIdx(0) }}>
              {finishLabel[f]}
            </button>
          ))}
        </div>
        <div className="tabs">
          {(['leftright', 'updown', 'vertical'] as Layout[]).map((l) => (
            <button key={l} className={layout === l ? 'tab active' : 'tab'} onClick={() => { setLayout(l); setSizeIdx(0) }}>
              {layoutLabel[l]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Size</span>
          <span className="field-input">
            <select value={sizeIdx} onChange={(e) => setSizeIdx(Number(e.target.value))}>
              {sizes.map((t, i) => (
                <option key={i} value={i}>
                  {t.w / 10} × {t.h / 10} cm
                </option>
              ))}
            </select>
          </span>
        </label>
        <h3>{primaryLabel}</h3>
        {lineEditor(primary, setPrimary)}
        <h3>{secondaryLabel}</h3>
        {lineEditor(secondary, setSecondary)}
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !spec} onClick={() => void make()}>
            {busy ? 'Building…' : '✨ Make my sign'}
          </button>
        </div>
      </div>
    </div>
  )
}
