import { useEffect, useRef, useState, useCallback } from 'react'
import { useStudio } from '../store/studio'
import { shapedSync } from '../shaping/service'
import { renderTextEl } from './textRender'
import { multiToD, barRing, roundedRectRing, circleRing, nearestOnRing } from '../geom/poly'
import type { TextEl, DividerEl } from '../model'
import { boltCenters } from '../model'

interface DragState {
  kind: 'move' | 'resize' | 'pan' | 'bridge'
  elId?: string
  moved?: boolean
  startWX: number
  startWY: number
  elStartX?: number
  elStartY?: number
  startHeight?: number
  startLength?: number
  startDist?: number
  startPanX?: number
  startPanY?: number
  startClientX?: number
  startClientY?: number
  bridgeKey?: string
  bridgeHole?: [number, number][]
}

export function Canvas() {
  const design = useStudio((s) => s.design)
  const selectedId = useStudio((s) => s.selectedId)
  const mode = useStudio((s) => s.mode)
  const zoom = useStudio((s) => s.zoom)
  const panX = useStudio((s) => s.panX)
  const panY = useStudio((s) => s.panY)
  const fin = useStudio((s) => s.fin)
  const finalizing = useStudio((s) => s.finalizing)
  useStudio((s) => s.shapeTick) // re-render when shaping results land

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null })

  const toWorld = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const rect = svgRef.current!.getBoundingClientRect()
      const s = useStudio.getState()
      return [(clientX - rect.left - s.panX) / s.zoom, (clientY - rect.top - s.panY) / s.zoom]
    },
    [],
  )

  // fit whenever another design is opened
  useEffect(() => {
    const el = wrapRef.current
    if (el) useStudio.getState().fitView(el.clientWidth, el.clientHeight)
  }, [design.id])

  // wheel: zoom (ctrl) / pan — must be a non-passive native listener
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = useStudio.getState()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * 0.0015)
        const nz = Math.min(20, Math.max(0.1, s.zoom * factor))
        const wx = (mx - s.panX) / s.zoom
        const wy = (my - s.panY) / s.zoom
        s.setView(nz, mx - wx * nz, my - wy * nz)
      } else if (e.shiftKey) {
        s.setView(s.zoom, s.panX - e.deltaY, s.panY)
      } else {
        s.setView(s.zoom, s.panX - e.deltaX, s.panY - e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const s = useStudio.getState()
      const step = e.shiftKey ? 5 : 1
      const sel = s.design.elements.find((el) => el.id === s.selectedId)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel) {
        e.preventDefault()
        s.duplicateEl(sel.id)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        const el = wrapRef.current
        if (el) s.fitView(el.clientWidth, el.clientHeight)
        return
      }
      if (!sel) return
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          s.updateEl(sel.id, { x: sel.x - step })
          break
        case 'ArrowRight':
          e.preventDefault()
          s.updateEl(sel.id, { x: sel.x + step })
          break
        case 'ArrowUp':
          e.preventDefault()
          s.updateEl(sel.id, { y: sel.y - step })
          break
        case 'ArrowDown':
          e.preventDefault()
          s.updateEl(sel.id, { y: sel.y + step })
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          s.removeEl(sel.id)
          break
        case 'Escape':
          s.select(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    const s = useStudio.getState()
    const target = e.target as SVGElement
    const [wx, wy] = toWorld(e.clientX, e.clientY)
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)

    if (e.button === 1 || e.button === 2) {
      dragRef.current = { kind: 'pan', startWX: wx, startWY: wy, startPanX: s.panX, startPanY: s.panY, startClientX: e.clientX, startClientY: e.clientY }
      return
    }

    const bridgeKey = target.getAttribute('data-bridge')
    if (bridgeKey && mode === 'finalize') {
      const bridge = s.fin?.bridges.find((b) => b.key === bridgeKey)
      if (bridge) {
        s.beginGesture()
        dragRef.current = { kind: 'bridge', bridgeKey, bridgeHole: bridge.holeRing, startWX: wx, startWY: wy }
        return
      }
    }

    const handle = target.getAttribute('data-handle')
    if (handle && s.selectedId) {
      const el = s.design.elements.find((x) => x.id === s.selectedId)
      if (el) {
        s.beginGesture()
        dragRef.current = {
          kind: 'resize',
          elId: el.id,
          startWX: wx,
          startWY: wy,
          startHeight: el.kind === 'text' ? el.heightMm : undefined,
          startLength: el.kind === 'divider' ? el.length : undefined,
          startDist: Math.max(1e-3, Math.hypot(wx - el.x, wy - el.y)),
        }
        return
      }
    }

    const elId = target.getAttribute('data-elid')
    if (elId && mode === 'design') {
      const el = s.design.elements.find((x) => x.id === elId)
      if (el) {
        s.select(elId)
        s.beginGesture()
        dragRef.current = { kind: 'move', elId, startWX: wx, startWY: wy, elStartX: el.x, elStartY: el.y }
        return
      }
    }
    s.select(null)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const s = useStudio.getState()
    const [wx, wy] = toWorld(e.clientX, e.clientY)

    if (drag.kind === 'pan') {
      s.setView(s.zoom, drag.startPanX! + (e.clientX - drag.startClientX!), drag.startPanY! + (e.clientY - drag.startClientY!))
      return
    }
    if (drag.kind === 'bridge' && drag.bridgeHole && drag.bridgeKey) {
      const { t } = nearestOnRing(drag.bridgeHole, [wx, wy])
      drag.moved = true
      s.setBridgeOverride(drag.bridgeKey, t)
      return
    }
    if (drag.kind === 'move' && drag.elId) {
      let nx = drag.elStartX! + (wx - drag.startWX)
      let ny = drag.elStartY! + (wy - drag.startWY)
      const snapTol = 5 / s.zoom
      const candX = [s.design.sign.w / 2, ...s.design.elements.filter((el) => el.id !== drag.elId).map((el) => el.x)]
      const candY = [s.design.sign.h / 2, ...s.design.elements.filter((el) => el.id !== drag.elId).map((el) => el.y)]
      let gv: number | null = null
      let gh: number | null = null
      for (const c of candX)
        if (Math.abs(nx - c) < snapTol) {
          nx = c
          gv = c
          break
        }
      for (const c of candY)
        if (Math.abs(ny - c) < snapTol) {
          ny = c
          gh = c
          break
        }
      setGuides({ v: gv, h: gh })
      drag.moved = true
      s.updateEl(drag.elId, { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 })
      return
    }
    if (drag.kind === 'resize' && drag.elId) {
      const el = s.design.elements.find((x) => x.id === drag.elId)
      if (!el) return
      const dist = Math.hypot(wx - el.x, wy - el.y)
      const ratio = dist / drag.startDist!
      drag.moved = true
      if (el.kind === 'text' && drag.startHeight) {
        s.updateEl(el.id, { heightMm: Math.max(3, Math.round(drag.startHeight * ratio * 10) / 10) })
      } else if (el.kind === 'divider' && drag.startLength) {
        s.updateEl(el.id, { length: Math.max(5, Math.round(drag.startLength * ratio * 10) / 10) })
      }
    }
  }

  const onPointerUp = () => {
    const s = useStudio.getState()
    const drag = dragRef.current
    if (drag && (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'bridge')) {
      // only commit an undo step if something actually changed - a plain
      // click-select must not pollute the history
      s.endGesture(!!drag.moved)
    }
    dragRef.current = null
    setGuides({ v: null, h: null })
  }

  const { sign } = design
  const outlineD = multiToD([[roundedRectRing(0, 0, sign.w, sign.h, sign.radius)]])
  const holes = boltCenters(sign).map(([x, y]) => multiToD([[circleRing(x, y, sign.boltDia / 2)]]))

  const px = (n: number) => n / zoom // constant screen-size in world units

  return (
    <div className="canvas-wrap" ref={wrapRef} onContextMenu={(e) => e.preventDefault()}>
      <svg
        ref={svgRef}
        className="canvas-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        <g transform={`translate(${panX} ${panY}) scale(${zoom})`}>
          {/* artboard */}
          <path d={outlineD} className="artboard" fillRule="evenodd" />
          {/* 10mm grid */}
          <defs>
            <pattern id="grid10" width="10" height="10" patternUnits="userSpaceOnUse">
              <path d="M10 0H0V10" fill="none" stroke="var(--grid)" strokeWidth={px(1)} />
            </pattern>
            <clipPath id="boardClip">
              <path d={outlineD} />
            </clipPath>
          </defs>
          <rect x={0} y={0} width={sign.w} height={sign.h} fill="url(#grid10)" clipPath="url(#boardClip)" pointerEvents="none" />
          <path d={outlineD} fill="none" stroke={mode === 'finalize' ? '#e5484d' : 'var(--board-line)'} strokeWidth={px(1.4)} pointerEvents="none" />
          {holes.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={mode === 'finalize' ? '#e5484d' : 'var(--board-line)'} strokeWidth={px(1.2)} pointerEvents="none" />
          ))}

          {mode === 'design' && (
            <DesignElements design={design} selectedId={selectedId} px={px} />
          )}
          {mode === 'finalize' && fin && (
            <g>
              {/* the true production shape: everything welded, then bridged */}
              <path d={multiToD(fin.geometry)} fill="var(--ink)" fillRule="evenodd" pointerEvents="none" />
              {fin.bridges.map((b) => (
                <polygon
                  key={b.key}
                  points={b.rect.map(([x, y]) => `${x},${y}`).join(' ')}
                  className={b.manual ? 'bridge manual' : 'bridge'}
                  data-bridge={b.key}
                />
              ))}
              {fin.tinyHoles.map((th, i) => (
                <circle key={i} cx={th.center[0]} cy={th.center[1]} r={px(9)} className="tiny-hole" pointerEvents="none" />
              ))}
            </g>
          )}

          {/* snap guides */}
          {guides.v !== null && <line x1={guides.v} y1={-20} x2={guides.v} y2={sign.h + 20} className="guide" strokeWidth={px(1)} />}
          {guides.h !== null && <line x1={-20} y1={guides.h} x2={sign.w + 20} y2={guides.h} className="guide" strokeWidth={px(1)} />}
        </g>
      </svg>
      <div className="zoom-controls">
        <button onClick={() => useStudio.getState().setView(Math.min(20, zoom * 1.25), panX, panY)}>+</button>
        <span>{Math.round(zoom * 25.4 / 96 * 100) >= 0 ? `${Math.round(zoom * 100) / 100}px/mm` : ''}</span>
        <button onClick={() => useStudio.getState().setView(Math.max(0.1, zoom / 1.25), panX, panY)}>−</button>
        <button
          onClick={() => {
            const el = wrapRef.current
            if (el) useStudio.getState().fitView(el.clientWidth, el.clientHeight)
          }}
        >
          fit
        </button>
      </div>
      {finalizing && <div className="finalizing-badge">computing bridges…</div>}
      {mode === 'finalize' && !finalizing && fin && (
        <div className="finalize-hint">drag a teal bridge to move it around its hole</div>
      )}
    </div>
  )
}

function DesignElements({ design, selectedId, px }: { design: ReturnType<typeof useStudio.getState>['design']; selectedId: string | null; px: (n: number) => number }) {
  return (
    <g>
      {design.elements.map((el) => (el.kind === 'text' ? <TextView key={el.id} el={el} selected={el.id === selectedId} px={px} /> : <DividerView key={el.id} el={el} selected={el.id === selectedId} px={px} />))}
    </g>
  )
}

function SelectionBox({ x, y, w, h, px }: { x: number; y: number; w: number; h: number; px: (n: number) => number }) {
  const hs = px(9)
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} className="selection" strokeWidth={px(1.4)} pointerEvents="none" />
      {corners.map(([cx, cy], i) => (
        <rect key={i} x={cx - hs / 2} y={cy - hs / 2} width={hs} height={hs} className="handle" data-handle={String(i)} strokeWidth={px(1)} />
      ))}
    </g>
  )
}

function TextView({ el, selected, px }: { el: TextEl; selected: boolean; px: (n: number) => number }) {
  const shaped = shapedSync(el.fontId, el.text, el.spacingEm)
  if (!shaped) {
    return (
      <g>
        <rect x={el.x - 25} y={el.y - 6} width={50} height={12} className="placeholder" data-elid={el.id} />
      </g>
    )
  }
  const r = renderTextEl(el, shaped)
  if (!r) {
    // empty / whitespace-only text still needs to be visible and selectable
    return (
      <g>
        <rect x={el.x - 25} y={el.y - 6} width={50} height={12} className="placeholder" data-elid={el.id} style={{ cursor: 'move' }} />
      </g>
    )
  }
  const pad = 2
  const bb = r.bboxMm
  return (
    <g>
      <g transform={r.transform}>
        <path d={r.d} fill="var(--ink)" pointerEvents="none" />
      </g>
      <rect x={bb.x - pad} y={bb.y - pad} width={bb.w + pad * 2} height={bb.h + pad * 2} fill="transparent" data-elid={el.id} style={{ cursor: 'move' }} />
      {selected && <SelectionBox x={bb.x - pad} y={bb.y - pad} w={bb.w + pad * 2} h={bb.h + pad * 2} px={px} />}
    </g>
  )
}

function DividerView({ el, selected, px }: { el: DividerEl; selected: boolean; px: (n: number) => number }) {
  const ring = barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)
  const d = multiToD([[ring]])
  const w = el.vertical ? el.thickness : el.length
  const h = el.vertical ? el.length : el.thickness
  const pad = 2.5
  return (
    <g>
      <path d={d} fill="var(--ink)" pointerEvents="none" />
      <rect x={el.x - w / 2 - pad} y={el.y - h / 2 - pad} width={w + pad * 2} height={h + pad * 2} fill="transparent" data-elid={el.id} style={{ cursor: 'move' }} />
      {selected && <SelectionBox x={el.x - w / 2 - pad} y={el.y - h / 2 - pad} w={w + pad * 2} h={h + pad * 2} px={px} />}
    </g>
  )
}
