import { useStudio } from '../store/studio'
import { downloadAi, downloadPdf, downloadProductionSvg, downloadClientPng } from './exportActions'

function Num({ label, value, onChange, step = 1, min, max, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="field-input">
        <input
          type="number"
          value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  )
}

export function PropertiesPanel() {
  const design = useStudio((s) => s.design)
  const selectedId = useStudio((s) => s.selectedId)
  const mode = useStudio((s) => s.mode)
  const fin = useStudio((s) => s.fin)
  const finalizing = useStudio((s) => s.finalizing)
  const fonts = useStudio((s) => s.fonts)
  const st = useStudio.getState()

  const sel = design.elements.find((e) => e.id === selectedId)

  return (
    <aside className="panel right">
      {mode === 'finalize' ? (
        <>
          <h3>Finalize · machine ready</h3>
          <p className="hint">
            Letters are welded to outlines. Every enclosed hole gets one bridge so it doesn't fall out when the laser cuts. Drag any teal
            bridge on the canvas to move it.
          </p>
          <Num label="Bridge width" value={design.fin.bridgeWidth} step={0.1} min={0.4} max={4} suffix="mm" onChange={(v) => st.setFin({ bridgeWidth: v })} />
          <Num label="Bridge clearance" value={design.fin.clearance} step={0.1} min={0} max={6} suffix="mm" onChange={(v) => st.setFin({ clearance: v })} />
          <Num label="Min hole area" value={design.fin.minHoleArea} step={0.5} min={0.5} max={30} suffix="mm²" onChange={(v) => st.setFin({ minHoleArea: v })} />
          <div className="row">
            <button onClick={() => st.clearBridgeOverrides()}>Reset bridges to auto</button>
          </div>
          {fin && fin.warnings.length > 0 && (
            <div className="warnings">
              {[...new Set(fin.warnings)].map((w, i) => (
                <div key={i} className="warning">⚠ {w}</div>
              ))}
            </div>
          )}
          <h3>Export</h3>
          <div className="stack">
            <button className="primary" disabled={!fin || finalizing} onClick={() => fin && downloadAi(design, fin)}>
              Download .ai (machine file)
            </button>
            <button disabled={!fin || finalizing} onClick={() => fin && downloadPdf(design, fin)}>
              Download .pdf
            </button>
            <button disabled={!fin || finalizing} onClick={() => fin && downloadProductionSvg(design, fin)}>
              Download production .svg
            </button>
            <button onClick={() => void downloadClientPng(design)}>Download client preview .png</button>
          </div>
          <p className="hint">1:1 scale — the page is exactly {(design.sign.w / 10).toFixed(0)}×{(design.sign.h / 10).toFixed(0)} cm. Red hairline = cut line.</p>
        </>
      ) : sel ? (
        sel.kind === 'text' ? (
          <>
            <h3>Text</h3>
            <label className="field col">
              <span>Content</span>
              <textarea
                dir="auto"
                rows={2}
                value={sel.text}
                onChange={(e) => st.updateEl(sel.id, { text: e.target.value.replace(/\n/g, ' ') })}
              />
            </label>
            <label className="field">
              <span>Font</span>
              <span className="field-input">
                <select value={sel.fontId} onChange={(e) => st.updateEl(sel.id, { fontId: e.target.value })}>
                  {fonts.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <Num label="Height" value={sel.heightMm} step={1} min={3} suffix="mm" onChange={(v) => st.updateEl(sel.id, { heightMm: v })} />
            <Num label="Tracking" value={sel.spacingEm * 100} step={1} min={0} max={40} suffix="%em" onChange={(v) => st.updateEl(sel.id, { spacingEm: v / 100 })} />
            <p className="hint">Tracking never breaks Arabic joins — it only spaces Latin letters and separate words.</p>
            <Num label="X" value={sel.x} suffix="mm" onChange={(v) => st.updateEl(sel.id, { x: v })} />
            <Num label="Y" value={sel.y} suffix="mm" onChange={(v) => st.updateEl(sel.id, { y: v })} />
            <div className="row">
              <button onClick={() => st.updateEl(sel.id, { x: design.sign.w / 2 })}>Center ↔</button>
              <button onClick={() => st.updateEl(sel.id, { y: design.sign.h / 2 })}>Center ↕</button>
            </div>
            <div className="row">
              <button onClick={() => st.duplicateEl(sel.id)}>Duplicate</button>
              <button className="danger" onClick={() => st.removeEl(sel.id)}>
                Delete
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Divider</h3>
            <label className="field">
              <span>Direction</span>
              <span className="field-input">
                <select value={sel.vertical ? 'v' : 'h'} onChange={(e) => st.updateEl(sel.id, { vertical: e.target.value === 'v' })}>
                  <option value="h">Horizontal</option>
                  <option value="v">Vertical</option>
                </select>
              </span>
            </label>
            <Num label="Length" value={sel.length} step={1} min={5} suffix="mm" onChange={(v) => st.updateEl(sel.id, { length: v })} />
            <Num label="Thickness" value={sel.thickness} step={0.1} min={0.4} suffix="mm" onChange={(v) => st.updateEl(sel.id, { thickness: v })} />
            <label className="field">
              <span>Round caps</span>
              <span className="field-input">
                <input type="checkbox" checked={sel.roundCaps} onChange={(e) => st.updateEl(sel.id, { roundCaps: e.target.checked })} />
              </span>
            </label>
            <Num label="X" value={sel.x} suffix="mm" onChange={(v) => st.updateEl(sel.id, { x: v })} />
            <Num label="Y" value={sel.y} suffix="mm" onChange={(v) => st.updateEl(sel.id, { y: v })} />
            <div className="row">
              <button onClick={() => st.updateEl(sel.id, { x: design.sign.w / 2 })}>Center ↔</button>
              <button onClick={() => st.updateEl(sel.id, { y: design.sign.h / 2 })}>Center ↕</button>
            </div>
            <div className="row">
              <button onClick={() => st.duplicateEl(sel.id)}>Duplicate</button>
              <button className="danger" onClick={() => st.removeEl(sel.id)}>
                Delete
              </button>
            </div>
          </>
        )
      ) : (
        <>
          <h3>Sign board</h3>
          <Num label="Width" value={design.sign.w / 10} step={0.5} min={5} suffix="cm" onChange={(v) => st.setSign({ w: v * 10 })} />
          <Num label="Height" value={design.sign.h / 10} step={0.5} min={5} suffix="cm" onChange={(v) => st.setSign({ h: v * 10 })} />
          <Num label="Corner radius" value={design.sign.radius} step={1} min={0} suffix="mm" onChange={(v) => st.setSign({ radius: v })} />
          <label className="field">
            <span>Mounting holes</span>
            <span className="field-input">
              <input type="checkbox" checked={design.sign.mountHoles} onChange={(e) => st.setSign({ mountHoles: e.target.checked })} />
            </span>
          </label>
          {design.sign.mountHoles && (
            <>
              <Num label="Hole ⌀" value={design.sign.holeDia} step={0.5} min={2} suffix="mm" onChange={(v) => st.setSign({ holeDia: v })} />
              <Num label="Hole inset" value={design.sign.holeInset} step={1} min={4} suffix="mm" onChange={(v) => st.setSign({ holeInset: v })} />
            </>
          )}
          <h3>Add</h3>
          <div className="row">
            <button onClick={() => st.addText()}>+ Text</button>
            <button onClick={() => st.addDivider()}>+ Divider</button>
          </div>
          <p className="hint">Select an element on the canvas to edit it. Arrows nudge 1mm (Shift = 5mm).</p>
        </>
      )}
    </aside>
  )
}
