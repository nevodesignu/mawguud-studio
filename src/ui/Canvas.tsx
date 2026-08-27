import { useEffect, useRef, useState, useCallback } from 'react'
import { useStudio } from '../store/studio'
import { shapedSync } from '../shaping/service'
import { renderTextEl } from './textRender'
import { multiToD, barRing, roundedRectRing, circleRing, nearestOnRing } from '../geom/poly'
import type { TextEl, DividerEl, El } from '../model'
import { boltCenters } from '../model'

interface DragState {
  kind: 'move' | 'resize' | 'pan' | 'bridge' | 'marquee'
  elId?: string
  moved?: boolean
  startWX: number
  startWY: number
  groupStart?: Map<string, { x: number; y: number }>
  resizeStarts?: Map<string, { x: number; y: number; heightMm?: number; length?: number }>
  centerX?: number
  centerY?: number
  startDist?: number
  startPanX?: number
  startPanY?: number
  startClientX?: number
  startClientY?: number
  bridgeKey?: string
  bridgeHole?: [number, number][]
  baseSelection?: string[]
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Design-space bounding box of an element (uses the shaping cache for text). */
function bboxOf(el: El): Box {
  if (el.kind === 'divider') {
    const w = el.vertical ? el.thickness : el.length
    const h = el.vertical ? el.length : el.thickness
    return { x: el.x - w / 2, y: el.y - h / 2, w, h }
  }
  const shaped = shapedSync(el.fontId, el.text, el.spacingEm)
  if (shaped) {
    const r = renderTextEl(el, shaped)
    if (r) return r.bboxMm
  }
  return { x: el.x - 25, y: el.y - 6, w: 50, h: 12 }
}

const boxesIntersect = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function Canvas() {
  const design = useStudio((s) => s.design)
  const selectedIds = useStudio((s) => s.selectedIds)
  const mode = useStudio((s) => s.mode)
  const zoom = useStudio((s) => s.zoom)
  const panX = useStudio((s) => s.panX)
  const panY = useStudio((s) => s.panY)
  const fin = useStudio((s) => s.fin)
  const finalizing = useStudio((s) => s.finalizing)
  const arranging = useStudio((s) => s.arranging)
  const outlineView = useStudio((s) => s.outlineView)
  useStudio((s) => s.shapeTick) // re-render when shaping results land

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null })
  const [marquee, setMarquee] = useState<Box | null>(null)

  const toWorld = useCallback((clientX: number, clientY: number): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect()
    const s = useStudio.getState()
    return [(clientX - rect.left - s.panX) / s.zoom, (clientY - rect.top - s.panY) / s.zoom]
  }, [])

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
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if (ctrl && key === 'y') {
        e.preventDefault()
        s.redo()
        return
      }
      if (ctrl && key === 'a') {
        e.preventDefault()
        s.selectAll()
        return
      }
      if (ctrl && key === 'c') {
        e.preventDefault()
        s.copySelected()
        return
      }
      if (ctrl && key === 'x') {
        e.preventDefault()
        s.cutSelected()
        return
      }
      if (ctrl && key === 'v') {
        e.preventDefault()
        s.paste()
        return
      }
      if (ctrl && key === 'd') {
        e.preventDefault()
        s.duplicateSelected()
        return
      }
      if (ctrl && e.key === '0') {
        e.preventDefault()
        const el = wrapRef.current
        if (el) s.fitView(el.clientWidth, el.clientHeight)
        return
      }
      if (!s.selectedIds.length) return
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          s.moveSelected(-step, 0)
          break
        case 'ArrowRight':
          e.preventDefault()
          s.moveSelected(step, 0)
          break
        case 'ArrowUp':
          e.preventDefault()
          s.moveSelected(0, -step)
          break
        case 'ArrowDown':
          e.preventDefault()
          s.moveSelected(0, step)
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          s.removeSelected()
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
    if (handle && s.selectedIds.length >= 1) {
      // resize the whole selection proportionally around its combined centre
      const sel = s.design.elements.filter((x) => s.selectedIds.includes(x.id))
      if (sel.length) {
        const boxes = sel.map(bboxOf)
        const centerX = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.w))) / 2
        const centerY = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.h))) / 2
        const resizeStarts = new Map<string, { x: number; y: number; heightMm?: number; length?: number }>()
        for (const el of sel) {
          resizeStarts.set(el.id, {
            x: el.x,
            y: el.y,
            heightMm: el.kind === 'text' ? el.heightMm : undefined,
            length: el.kind === 'divider' ? el.length : undefined,
          })
        }
        s.beginGesture()
        dragRef.current = {
          kind: 'resize',
          startWX: wx,
          startWY: wy,
          resizeStarts,
          centerX,
          centerY,
          startDist: Math.max(1e-3, Math.hypot(wx - centerX, wy - centerY)),
        }
        return
      }
    }

    const elId = target.getAttribute('data-elid')
    if (elId && mode === 'design') {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      if (additive) {
        s.select(elId, true)
        return
      }
      if (!s.selectedIds.includes(elId)) s.select(elId)
      const ids = useStudio.getState().selectedIds
      const groupStart = new Map<string, { x: number; y: number }>()
      for (const el of s.design.elements) if (ids.includes(el.id)) groupStart.set(el.id, { x: el.x, y: el.y })
      s.beginGesture()
      dragRef.current = { kind: 'move', elId, startWX: wx, startWY: wy, groupStart }
      return
    }

    if (mode === 'design') {
      // empty canvas: start marquee selection
      dragRef.current = { kind: 'marquee', startWX: wx, startWY: wy, baseSelection: e.shiftKey ? s.selectedIds : [] }
      if (!e.shiftKey) s.select(null)
      return
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
    if (drag.kind === 'marquee') {
      const box: Box = {
        x: Math.min(drag.startWX, wx),
        y: Math.min(drag.startWY, wy),
        w: Math.abs(wx - drag.startWX),
        h: Math.abs(wy - drag.startWY),
      }
      setMarquee(box)
      const hits = s.design.elements.filter((el) => boxesIntersect(box, bboxOf(el))).map((el) => el.id)
      s.selectMany([...new Set([...(drag.baseSelection ?? []), ...hits])])
      return
    }
    if (drag.kind === 'bridge' && drag.bridgeHole && drag.bridgeKey) {
      const { t } = nearestOnRing(drag.bridgeHole, [wx, wy])
      drag.moved = true
      s.setBridgeOverride(drag.bridgeKey, t)
      return
    }
    if (drag.kind === 'move' && drag.elId && drag.groupStart) {
      const primaryStart = drag.groupStart.get(drag.elId)
      if (!primaryStart) return
      let dx = wx - drag.startWX
      let dy = wy - drag.startWY
      // snap by the primary dragged element's centre
      const snapTol = 5 / s.zoom
      const others = s.design.elements.filter((el) => !drag.groupStart!.has(el.id))
      const candX = [s.design.sign.w / 2, ...others.map((el) => el.x)]
      const candY = [s.design.sign.h / 2, ...others.map((el) => el.y)]
      let gv: number | null = null
      let gh: number | null = null
      const px = primaryStart.x + dx
      const py = primaryStart.y + dy
      for (const c of candX)
        if (Math.abs(px - c) < snapTol) {
          dx += c - px
          gv = c
          break
        }
      for (const c of candY)
        if (Math.abs(py - c) < snapTol) {
          dy += c - py
          gh = c
          break
        }
      setGuides({ v: gv, h: gh })
      drag.moved = true
      s.mutate(
        (d) => {
          for (const el of d.elements) {
            const st = drag.groupStart!.get(el.id)
            if (st) {
              el.x = Math.round((st.x + dx) * 10) / 10
              el.y = Math.round((st.y + dy) * 10) / 10
            }
          }
        },
        { history: false },
      )
      return
    }
    if (drag.kind === 'resize' && drag.resizeStarts) {
      const cx = drag.centerX!
      const cy = drag.centerY!
      const ratio = Math.min(50, Math.max(0.05, Math.hypot(wx - cx, wy - cy) / drag.startDist!))
      drag.moved = true
      s.mutate(
        (d) => {
          for (const el of d.elements) {
            const st = drag.resizeStarts!.get(el.id)
            if (!st) continue
            el.x = Math.round((cx + (st.x - cx) * ratio) * 10) / 10
            el.y = Math.round((cy + (st.y - cy) * ratio) * 10) / 10
            if (el.kind === 'text' && st.heightMm) el.heightMm = Math.max(3, Math.round(st.heightMm * ratio * 10) / 10)
            if (el.kind === 'divider' && st.length) el.length = Math.max(5, Math.round(st.length * ratio * 10) / 10)
          }
        },
        { history: false },
      )
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
    setMarquee(null)
  }

  const { sign } = design
  const outlineD = multiToD([[roundedRectRing(0, 0, sign.w, sign.h, sign.radius)]])
  const holes = boltCenters(sign).map(([x, y]) => multiToD([[circleRing(x, y, sign.boltDia / 2)]]))

  const px = (n: number) => n / zoom // constant screen-size in world units

  const selectedEls = design.elements.filter((el) => selectedIds.includes(el.id))
  let groupBox: Box | null = null
  if (mode === 'design' && selectedEls.length > 1) {
    const boxes = selectedEls.map(bboxOf)
    const minX = Math.min(...boxes.map((b) => b.x))
    const minY = Math.min(...boxes.map((b) => b.y))
    const maxX = Math.max(...boxes.map((b) => b.x + b.w))
    const maxY = Math.max(...boxes.map((b) => b.y + b.h))
    groupBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

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
          <path d={outlineD} fill="none" stroke={mode === 'finalize' ? '#e5484d' : 'var(--board-line)'} strokeWidth={px(1.4)} pointerEvents="none" />
          {holes.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={mode === 'finalize' ? '#e5484d' : 'var(--board-line)'} strokeWidth={px(1.2)} pointerEvents="none" />
          ))}

          {mode === 'design' && (
            <g>
              {design.elements.map((el) =>
                el.kind === 'text' ? (
                  <TextView key={el.id} el={el} selected={selectedIds.includes(el.id)} single={selectedIds.length === 1} px={px} />
                ) : (
                  <DividerView key={el.id} el={el} selected={selectedIds.includes(el.id)} single={selectedIds.length === 1} px={px} />
                ),
              )}
              {groupBox && (
                <g>
                  <rect x={groupBox.x - 3} y={groupBox.y - 3} width={groupBox.w + 6} height={groupBox.h + 6} className="group-box" strokeWidth={px(1.2)} strokeDasharray={`${px(6)} ${px(4)}`} pointerEvents="none" />
                  <SelectionBox x={groupBox.x - 3} y={groupBox.y - 3} w={groupBox.w + 6} h={groupBox.h + 6} px={px} handles onlyHandles />
                </g>
              )}
              {marquee && (
                <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} className="marquee" strokeWidth={px(1)} pointerEvents="none" />
              )}
            </g>
          )}
          {mode === 'finalize' && fin && (
            <g>
              {/* the true production shape: everything welded, then bridged */}
              {outlineView ? (
                <path d={multiToD(fin.geometry)} fill="none" stroke="var(--ink)" strokeWidth={px(1.6)} pointerEvents="none" />
              ) : (
                <path d={multiToD(fin.geometry)} fill="var(--ink)" fillRule="evenodd" pointerEvents="none" />
              )}
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
        <span>{`${Math.round(zoom * 100) / 100}px/mm`}</span>
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
      {(finalizing || arranging) && <div className="finalizing-badge">{arranging ? 'arranging…' : 'computing bridges…'}</div>}
      {mode === 'finalize' && !finalizing && fin && (
        <div className="finalize-hint">drag a teal bridge to move it around its hole</div>
      )}
    </div>
  )
}

function SelectionBox({ x, y, w, h, px, handles, onlyHandles }: { x: number; y: number; w: number; h: number; px: (n: number) => number; handles: boolean; onlyHandles?: boolean }) {
  const hs = px(9)
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
  return (
    <g>
      {!onlyHandles && <rect x={x} y={y} width={w} height={h} className="selection" strokeWidth={px(1.4)} pointerEvents="none" />}
      {handles &&
        corners.map(([cx, cy], i) => (
          <rect key={i} x={cx - hs / 2} y={cy - hs / 2} width={hs} height={hs} className="handle" data-handle={String(i)} strokeWidth={px(1)} />
        ))}
    </g>
  )
}

function TextView({ el, selected, single, px }: { el: TextEl; selected: boolean; single: boolean; px: (n: number) => number }) {
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
      {selected && <SelectionBox x={bb.x - pad} y={bb.y - pad} w={bb.w + pad * 2} h={bb.h + pad * 2} px={px} handles={single} />}
    </g>
  )
}

function DividerView({ el, selected, single, px }: { el: DividerEl; selected: boolean; single: boolean; px: (n: number) => number }) {
  const ring = barRing(el.x, el.y, el.length, el.thickness, el.vertical, el.roundCaps)
  const d = multiToD([[ring]])
  const w = el.vertical ? el.thickness : el.length
  const h = el.vertical ? el.length : el.thickness
  const pad = 2.5
  return (
    <g>
      <path d={d} fill="var(--ink)" pointerEvents="none" />
      <rect x={el.x - w / 2 - pad} y={el.y - h / 2 - pad} width={w + pad * 2} height={h + pad * 2} fill="transparent" data-elid={el.id} style={{ cursor: 'move' }} />
      {selected && <SelectionBox x={el.x - w / 2 - pad} y={el.y - h / 2 - pad} w={w + pad * 2} h={h + pad * 2} px={px} handles={single} />}
    </g>
  )
}
