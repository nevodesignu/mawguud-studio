import { useStudio } from '../store/studio'
import { downloadClientPng } from './exportActions'

export function TopBar() {
  const design = useStudio((s) => s.design)
  const mode = useStudio((s) => s.mode)
  const saved = useStudio((s) => s.saved)
  const st = useStudio.getState()

  return (
    <header className="topbar">
      <div className="brand">
        MAWGUUD <span>STUDIO</span>
      </div>
      <input className="design-name" value={design.name} onChange={(e) => st.setName(e.target.value)} spellCheck={false} />
      <div className="seg">
        <button className={mode === 'design' ? 'active' : ''} onClick={() => st.setMode('design')}>
          1 · Design
        </button>
        <button className={mode === 'finalize' ? 'active' : ''} onClick={() => st.setMode('finalize')}>
          2 · Finalize
        </button>
      </div>
      <div className="topbar-right">
        <button title="Undo (Ctrl+Z)" onClick={() => st.undo()}>
          ↩
        </button>
        <button title="Redo (Ctrl+Shift+Z)" onClick={() => st.redo()}>
          ↪
        </button>
        <button onClick={() => void downloadClientPng(design)}>Client preview</button>
        <span className={saved ? 'save-dot saved' : 'save-dot'} title={saved ? 'Saved' : 'Saving…'}>
          {saved ? 'Saved' : 'Saving…'}
        </span>
      </div>
    </header>
  )
}
