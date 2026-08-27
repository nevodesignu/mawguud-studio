import { useEffect } from 'react'
import { TopBar } from './ui/TopBar'
import { LeftPanel } from './ui/LeftPanel'
import { Canvas } from './ui/Canvas'
import { PropertiesPanel } from './ui/PropertiesPanel'
import { useStudio } from './store/studio'
import { bootHB } from './shaping/hbLoader'
import { onShapedReady } from './shaping/service'
import { builtinFonts, listUploadedFonts } from './fonts/catalog'

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__studio = useStudio
}

export default function App() {
  useEffect(() => {
    const st = useStudio.getState()
    const off = onShapedReady(() => useStudio.getState().bumpShapeTick())
    void bootHB().then(() => useStudio.getState().bumpShapeTick())
    void (async () => {
      const uploaded = await listUploadedFonts()
      st.setFonts([...builtinFonts.map(({ url: _url, ...meta }) => meta), ...uploaded])
      await st.refreshDesigns()
    })()
    // best-effort flush of the debounced autosave when the tab closes
    const onUnload = () => void useStudio.getState().flushSave()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      off()
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <LeftPanel />
        <Canvas />
        <PropertiesPanel />
      </div>
    </div>
  )
}
