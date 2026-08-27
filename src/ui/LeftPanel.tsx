import { useRef, useState } from 'react'
import { useStudio } from '../store/studio'
import { templateCatalog, finishLabel, layoutLabel, type Finish, type Layout } from '../model'
import { addUploadedFont, removeUploadedFont, builtinFonts, listUploadedFonts } from '../fonts/catalog'
import { evictFont, shapedSync } from '../shaping/service'
import { renderTextEl } from './textRender'
import { SignBot } from './SignBot'

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
  const [finish, setFinish] = useState<Finish>('lighted')
  const [layout, setLayout] = useState<Layout>('leftright')
  const [botOpen, setBotOpen] = useState(false)
  const sizes = templateCatalog.filter((t) => t.finish === finish && t.layout === layout)
  return (
    <div className="list">
      <button className="primary" onClick={() => setBotOpen(true)}>
        🤖 Sign Bot — make my sign
      </button>
      {botOpen && <SignBot onClose={() => setBotOpen(false)} />}
      <div className="tabs">
        {(['lighted', 'mirror'] as Finish[]).map((f) => (
          <button key={f} className={finish === f ? 'tab active' : 'tab'} onClick={() => setFinish(f)}>
            {finishLabel[f]}
          </button>
        ))}
      </div>
      <div className="tabs">
        {(['leftright', 'updown', 'vertical'] as Layout[]).map((l) => (
          <button key={l} className={layout === l ? 'tab active' : 'tab'} onClick={() => setLayout(l)}>
            {layoutLabel[l]}
          </button>
        ))}
      </div>
      <div className="size-grid">
        {sizes.map((t) => (
          <button key={`${t.w}x${t.h}`} className="card size-card" onClick={() => st.newFromTemplate(t)}>
            <strong>
              {t.w / 10}×{t.h / 10}
            </strong>
            <span>cm</span>
          </button>
        ))}
      </div>
      <button className="card" onClick={() => st.newBlank()}>
        <strong>Blank board</strong>
        <span>30×15 cm, empty</span>
      </button>
      <p className="hint">
        Real Mawguud specs: bolt size, bolt spacing, and divider thickness are measured from the production .ai templates.
      </p>
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
          for (const f of Array.from(files)) {
            const meta = await addUploadedFont(f)
            // re-uploading a corrected font under the same name must not keep
            // shaping (and EXPORTING) with the stale cached bytes
            evictFont(meta.id)
          }
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
                if (!window.confirm(`Delete the font "${f.name}"? Any saved design using it will stop rendering until you re-upload it.`)) return
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
      <p className="hint">
        Mawguud's production font is <strong>Avenir Arabic Medium</strong> (found inside the real templates). Upload its .otf/.ttf here
        and pick it per text element to match the real signs exactly.
      </p>
    </div>
  )
}
