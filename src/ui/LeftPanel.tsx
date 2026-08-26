import { useRef, useState } from 'react'
import { useStudio } from '../store/studio'
import { templates } from '../model'
import { addUploadedFont, removeUploadedFont, builtinFonts, listUploadedFonts } from '../fonts/catalog'
import { evictFont, shapedSync } from '../shaping/service'
import { renderTextEl } from './textRender'

type Tab = 'designs' | 'templates' | 'fonts'

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('templates')
  return (
    <aside className="panel left">
      <div className="tabs">
        {(['templates', 'designs', 'fonts'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'templates' && <Templates />}
      {tab === 'designs' && <Designs />}
      {tab === 'fonts' && <Fonts />}
    </aside>
  )
}

function Templates() {
  const st = useStudio.getState()
  return (
    <div className="list">
      {templates.map((t) => (
        <button key={t.id} className="card" onClick={() => st.newFromTemplate(t.id)}>
          <strong>{t.name}</strong>
          <span>{t.hint}</span>
        </button>
      ))}
      <p className="hint">Templates start a new design. Your own .ai templates can be added as presets later.</p>
    </div>
  )
}

function Designs() {
  const designs = useStudio((s) => s.designs)
  const current = useStudio((s) => s.design)
  const st = useStudio.getState()
  return (
    <div className="list">
      <div className="row">
        <button onClick={() => st.duplicateDesign()}>Duplicate current</button>
      </div>
      {designs.length === 0 && <p className="hint">Saved designs appear here automatically.</p>}
      {designs.map((d) => (
        <div key={d.id} className={d.id === current.id ? 'card row-card active' : 'card row-card'}>
          <button className="card-main" onClick={() => void st.openDesign(d.id)}>
            <strong>{d.name}</strong>
            <span>
              {d.size} · {new Date(d.updatedAt).toLocaleDateString()}
            </span>
          </button>
          <button className="icon danger" title="Delete design" onClick={() => void st.deleteDesign(d.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function FontSample({ fontId }: { fontId: string }) {
  useStudio((s) => s.shapeTick)
  const shaped = shapedSync(fontId, 'أحمد Ali 85', 0)
  if (!shaped) return <div className="font-sample" />
  const r = renderTextEl({ id: 's', kind: 'text', text: '', fontId, heightMm: 9, x: 60, y: 8, spacingEm: 0 }, shaped)
  if (!r) return <div className="font-sample" />
  return (
    <div className="font-sample">
      <svg viewBox="0 0 120 16">
        <g transform={r.transform}>
          <path d={r.d} fill="currentColor" />
        </g>
      </svg>
    </div>
  )
}

function Fonts() {
  const fonts = useStudio((s) => s.fonts)
  const st = useStudio.getState()
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    const uploaded = await listUploadedFonts()
    st.setFonts([...builtinFonts.map(({ url: _url, ...meta }) => meta), ...uploaded])
  }

  return (
    <div className="list">
      <button
        className="primary"
        onClick={() => fileRef.current?.click()}
      >
        Upload font (.ttf / .otf)
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf"
        multiple
        hidden
        onChange={async (e) => {
          const files = e.target.files
          if (!files) return
          for (const f of Array.from(files)) await addUploadedFont(f)
          e.target.value = ''
          await refresh()
        }}
      />
      {fonts.map((f) => (
        <div key={f.id} className="card row-card">
          <div className="card-main">
            <strong>{f.name}</strong>
            <FontSample fontId={f.id} />
          </div>
          {!f.builtin && (
            <button
              className="icon danger"
              title="Remove font"
              onClick={async () => {
                await removeUploadedFont(f.id)
                evictFont(f.id)
                await refresh()
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <p className="hint">Arabic fonts must be real OpenType fonts — the preview above shows exactly how letters will join and cut.</p>
    </div>
  )
}
