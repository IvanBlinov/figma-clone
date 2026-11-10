import { useEffect, useRef } from 'react'
import { cloneSubtrees, descendants, kids, nextOrder, parentOf, ROOT, topLevelOnly } from '../../shared/doc'
import {
  apply,
  boundsOf,
  boxContains,
  boxesIntersect,
  corners,
  decompose,
  invert,
  matRotation,
  mul,
  rotateAround,
  unionBoxes,
  type Box,
  type Mat,
  type Pt,
} from '../../shared/geometry'
import { isAutoLayout, type NodeType, type Op, type SceneNode } from '../../shared/types'
import { serializePath, smoothPath, subsBounds, transformSubs, type SubPath } from '../../shared/vector'
import { addReaction, componentsToInstances, createInstance, makeNode, placeImage, placement, sizeSideEffects, commitDraft, toggleTextStyle, topFrameOf, zoomAt } from './actions'
import { frameAt, hitPath, parentWorld, pick, pickDeeper, snapBox, worldBoxOf } from './hit'
import { drawNodes, drawOverlay, frameLabels, protoHandle, RULER, selectionBox, setImageLoadCallback, visibleRootIds, type RemoteUser, type SelectionBox } from './render'
import { clearDraft, commit, patchState, S, screenToWorld, select, setDraft, setTool, useEditor, type Tool } from './store'
import {
  applyTextInput,
  finishTextEdit,
  focusProxy,
  moveCaretLineEdge,
  moveCaretVertical,
  registerProxy,
  selectAllText,
  selectWordAt,
  setTextSel,
  startTextEdit,
  syncSelFromProxy,
  textIndexAt,
} from './textEdit'
import { cloneSubs, editSubs, flatPoints, writeSubs } from './vectorEdit'
import { commitVectorEdit, enterVectorEdit, exitVectorEdit, insertVectorPoint, toggleSmooth, vectorHit, veditNode } from './vectorOps'

export { finishTextEdit, startTextEdit } from './textEdit'

const SHAPE_TOOLS: Partial<Record<Tool, NodeType>> = {
  frame: 'FRAME',
  rectangle: 'RECTANGLE',
  ellipse: 'ELLIPSE',
  line: 'LINE',
  arrow: 'LINE',
  polygon: 'POLYGON',
  star: 'STAR',
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'line-start' | 'line-end'
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'marquee'; start: Pt; base: string[]; clickSelect: string | null; moved: boolean }
  | {
      kind: 'move'
      start: Pt
      sx: number
      sy: number
      ids: string[]
      orig: Map<string, SceneNode>
      pm: Map<string, Mat>
      box: Box
      moved: boolean
      clickId: string | null
      dupes: SceneNode[] | null
      exclude: Set<string>
    }
  | { kind: 'resize'; handle: Handle; box: SelectionBox; ids: string[]; orig: Map<string, SceneNode>; world: Map<string, Mat>; pm: Map<string, Mat> }
  | { kind: 'rotate'; center: Pt; startAngle: number; ids: string[]; world: Map<string, Mat>; pm: Map<string, Mat> }
  | { kind: 'create'; type: NodeType; start: Pt; id: string; pm: Mat; moved: boolean }
  | { kind: 'text'; start: Pt; sx: number; sy: number }
  | { kind: 'pen'; index: number }
  | { kind: 'pencil' }
  | { kind: 'textsel'; anchor: number }
  | { kind: 'proto'; from: string }
  | { kind: 'vpoint'; id: string; orig: SubPath[]; start: Pt; sel: number[]; moved: boolean }
  | { kind: 'vhandle'; id: string; orig: SubPath[]; index: number; which: 'in' | 'out'; moved: boolean }

const ROTATE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M5 13a7 7 0 1 1 7 7' fill='none' stroke='white' stroke-width='4'/%3E%3Cpath d='M5 13a7 7 0 1 1 7 7' fill='none' stroke='black' stroke-width='1.6'/%3E%3Cpath d='M2 11l3 4 3-4z' fill='black' stroke='white' stroke-width='.8'/%3E%3C/svg%3E\") 12 12, crosshair"

function resizeCursor(handle: Handle, boxAngle: number): string {
  if (handle.startsWith('line')) return 'move'
  const base = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 }[handle as 'e']
  const a = (((base + boxAngle) % 180) + 180) % 180
  if (a < 22.5 || a >= 157.5) return 'ew-resize'
  if (a < 67.5) return 'nwse-resize'
  if (a < 112.5) return 'ns-resize'
  return 'nesw-resize'
}

/** Which selection handle (if any) is under a screen point. */
function handleAt(sx: number, sy: number): { type: 'resize' | 'rotate'; handle: Handle; angle: number } | null {
  const st = S()
  if (st.tool !== 'move' || st.editingId || st.vedit) return null
  const box = selectionBox(st)
  if (!box) return null
  if (st.selection.some((id) => st.doc.byId.get(id)?.locked)) return null
  const z = st.viewport.zoom
  const sm: Mat = [box.m[0] * z, box.m[1] * z, box.m[2] * z, box.m[3] * z, box.m[4] * z + st.viewport.x, box.m[5] * z + st.viewport.y]
  const q = apply(invert(sm), { x: sx, y: sy })
  const qx = q.x * z
  const qy = q.y * z
  const W = box.w * z
  const H = box.h * z
  const angle = matRotation(box.m)
  if (box.single?.type === 'LINE') {
    if (Math.hypot(qx, qy) <= 7) return { type: 'resize', handle: 'line-start', angle }
    if (Math.hypot(qx - W, qy) <= 7) return { type: 'resize', handle: 'line-end', angle }
    return null
  }
  const multiRotated = !box.single && st.selection.some((id) => Math.abs(matRotation(st.world.get(id)!)) > 0.01)
  const cs: [Handle, number, number][] = [
    ['nw', 0, 0],
    ['ne', W, 0],
    ['se', W, H],
    ['sw', 0, H],
  ]
  if (!multiRotated) {
    for (const [h, cx, cy] of cs) if (Math.abs(qx - cx) <= 5 && Math.abs(qy - cy) <= 5) return { type: 'resize', handle: h, angle }
    const inX = qx > 0 && qx < W
    const inY = qy > 0 && qy < H
    if (inX && Math.abs(qy) <= 4) return { type: 'resize', handle: 'n', angle }
    if (inX && Math.abs(qy - H) <= 4) return { type: 'resize', handle: 's', angle }
    if (inY && Math.abs(qx) <= 4) return { type: 'resize', handle: 'w', angle }
    if (inY && Math.abs(qx - W) <= 4) return { type: 'resize', handle: 'e', angle }
  }
  const outside = qx < 0 || qy < 0 || qx > W || qy > H
  if (outside) for (const [h, cx, cy] of cs) if (Math.hypot(qx - cx, qy - cy) <= 20) return { type: 'rotate', handle: h, angle }
  return null
}

function labelAt(sx: number, sy: number, ctx: CanvasRenderingContext2D): string | null {
  for (const l of frameLabels(S(), ctx).reverse()) {
    const r = (-l.angle * Math.PI) / 180
    const dx = sx - l.x
    const dy = sy - l.y
    const qx = dx * Math.cos(r) - dy * Math.sin(r)
    const qy = dx * Math.sin(r) + dy * Math.cos(r)
    if (qx >= -2 && qx <= l.w + 4 && qy >= -20 && qy <= -1 && !S().doc.byId.get(l.id)?.locked) return l.id
  }
  return null
}

/** Nearest ancestor that is not a group (groups never "own" a drop). */
function container(id: string): string {
  const { doc } = S()
  let p = parentOf(doc, id)
  while (p !== ROOT && doc.byId.get(p)?.type === 'GROUP') p = parentOf(doc, p)
  return p
}

function flowIndex(parentId: string, p: Pt, exclude: Set<string>): number {
  const st = S()
  const parent = st.doc.byId.get(parentId)!
  const q = apply(invert(st.world.get(parentId)!), p)
  const horiz = parent.layoutMode === 'HORIZONTAL'
  let i = 0
  for (const k of kids(st.doc, parentId)) {
    if (exclude.has(k)) continue
    const c = st.doc.byId.get(k)!
    if (c.layoutPositioning === 'ABSOLUTE') {
      i++
      continue
    }
    const mid = horiz ? c.x + c.width / 2 : c.y + c.height / 2
    if ((horiz ? q.x : q.y) > mid) i++
    else break
  }
  return i
}

/** Create a VECTOR node from bezier subpaths given in world coordinates. */
function createVector(subs: SubPath[], filled: boolean, keepTool = false) {
  const st = S()
  const first = subs[0]?.pts[0]
  if (!first) return
  const pl = placement(first)
  const local = transformSubs(subs, invert(pl.world))
  const bb = subsBounds(local)
  const w = Math.max(1, Math.round(bb.w * 100) / 100)
  const h = Math.max(1, Math.round(bb.h * 100) / 100)
  const node = makeNode('VECTOR', {
    parentId: pl.parentId,
    x: Math.round(bb.x * 100) / 100,
    y: Math.round(bb.y * 100) / 100,
    width: w,
    height: h,
    vectorPath: serializePath(transformSubs(local, [1, 0, 0, 1, -bb.x, -bb.y])),
    vectorWidth: w,
    vectorHeight: h,
    fills: filled ? [{ type: 'SOLID', color: '#D9D9D9' }] : [],
    ...(keepTool ? { strokeCap: 'ROUND' as const } : {}),
  })
  node.order = nextOrder(st.doc, node.parentId ?? ROOT)
  commit([{ op: 'create', node }], { select: [node.id] })
  if (!keepTool) setTool('move')
}

export function finishPen(closed: boolean) {
  const pts = S().pen?.points ?? []
  patchState({ pen: null })
  if (pts.length < 2) return
  createVector([{ closed, pts: pts.map((p) => ({ x: p.x, y: p.y, ix: p.x - p.hx, iy: p.y - p.hy, ox: p.x + p.hx, oy: p.y + p.hy })) }], closed)
}

function finishPencil() {
  const st = S()
  const pts = st.pencil
  patchState({ pencil: null })
  if (!pts || pts.length < 2) return
  createVector([smoothPath(pts, 1.2 / st.viewport.zoom)], false, true)
}

interface Props {
  remotes: RemoteUser[]
  onCursor: (p: Pt) => void
  onCommentAt: (p: Pt) => void
  onContextMenu: (x: number, y: number, world: Pt) => void
}

export function Canvas({ remotes, onCursor, onCommentAt, onContextMenu }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  /** Click counter (pointer events carry no click count of their own). */
  const lastDown = useRef({ t: 0, x: 0, y: 0, n: 0 })
  const remotesRef = useRef(remotes)
  const schedule = useRef<() => void>(() => {})
  remotesRef.current = remotes

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const draw = () => {
      raf = 0
      const st = S()
      const dpr = window.devicePixelRatio || 1
      const { w, h } = st.canvasSize
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = st.pageBg
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const s = st.viewport.zoom * dpr
      ctx.setTransform(s, 0, 0, s, st.viewport.x * dpr, st.viewport.y * dpr)
      drawNodes(ctx, st.doc, visibleRootIds(st), s, { grids: st.showGrids })
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawOverlay(ctx, st, remotesRef.current)
    }
    schedule.current = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const unsub = useEditor.subscribe(schedule.current)
    const unsubImages = setImageLoadCallback(schedule.current)
    const measure = () => {
      const r = wrap.current!.getBoundingClientRect()
      const cur = S().canvasSize
      if (cur.w !== r.width || cur.h !== r.height) patchState({ canvasSize: { w: Math.max(1, r.width), h: Math.max(1, r.height) } })
    }
    measure() // before any zoom-to-fit runs
    const ro = new ResizeObserver(measure)
    ro.observe(wrap.current!)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const st = S()
      if (e.ctrlKey || e.metaKey) {
        const dy = Math.max(-60, Math.min(60, e.deltaY))
        zoomAt(st.viewport.zoom * Math.exp(-dy * 0.006), e.clientX - r.left, e.clientY - r.top)
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        patchState({ viewport: { ...st.viewport, x: st.viewport.x - dx, y: st.viewport.y - dy } })
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    schedule.current()
    return () => {
      unsub()
      unsubImages()
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => schedule.current(), [remotes])

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }
  const setCursor = (c: string) => {
    if (ref.current && ref.current.style.cursor !== c) ref.current.style.cursor = c
  }

  const beginMove = (ids: string[], p: Pt, sx: number, sy: number, clickId: string | null) => {
    const st = S()
    const top = topLevelOnly(st.doc, ids).filter((id) => !st.doc.byId.get(id)!.locked)
    if (!top.length) return
    const exclude = new Set<string>()
    for (const id of top) {
      exclude.add(id)
      for (const d of descendants(st.doc, id)) exclude.add(d)
    }
    drag.current = {
      kind: 'move',
      start: p,
      sx,
      sy,
      ids: top,
      orig: new Map(top.map((id) => [id, st.doc.byId.get(id)!])),
      pm: new Map(top.map((id) => [id, parentWorld(st, id)])),
      box: unionBoxes(top.map((id) => worldBoxOf(st, id))),
      moved: false,
      clickId,
      dupes: null,
      exclude,
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const { sx, sy } = pos(e)
    const st = S()
    const p = screenToWorld(sx, sy)
    ref.current!.setPointerCapture(e.pointerId)
    if (st.showRulers && (sx < RULER || sy < RULER)) return
    if (st.editingId) {
      const idx = e.button === 0 ? textIndexAt(p, 4 / st.viewport.zoom) : null
      if (idx !== null) {
        focusProxy()
        const ld = lastDown.current
        const now = performance.now()
        const n = now - ld.t < 450 && Math.hypot(sx - ld.x, sy - ld.y) < 5 ? ld.n + 1 : 1
        lastDown.current = { t: now, x: sx, y: sy, n }
        if (n >= 3) selectAllText()
        else if (n === 2) selectWordAt(idx)
        else {
          const anchor = e.shiftKey && st.textSel ? st.textSel.start : idx
          setTextSel(anchor, idx)
          drag.current = { kind: 'textsel', anchor }
        }
        return
      }
      finishTextEdit()
      if (st.tool !== 'text') return
    }
    if (e.button === 1 || st.tool === 'hand' || st.spaceDown) {
      drag.current = { kind: 'pan', sx, sy, vx: st.viewport.x, vy: st.viewport.y }
      setCursor('grabbing')
      return
    }
    if (e.button !== 0) return
    const tool = st.tool

    if (st.vedit) {
      const n = veditNode()
      if (!n) return exitVectorEdit()
      const hit = vectorHit(sx, sy)
      if (!hit) {
        if (st.vedit.sel.length) patchState({ vedit: { id: n.id, sel: [] } })
        else exitVectorEdit()
        return
      }
      if (hit.type === 'segment') return insertVectorPoint(hit)
      if (hit.type === 'anchor') {
        const has = st.vedit.sel.includes(hit.index)
        const sel = e.shiftKey ? (has ? st.vedit.sel.filter((i) => i !== hit.index) : [...st.vedit.sel, hit.index]) : has ? st.vedit.sel : [hit.index]
        patchState({ vedit: { id: n.id, sel } })
        drag.current = { kind: 'vpoint', id: n.id, orig: cloneSubs(editSubs(n)), start: apply(invert(st.world.get(n.id)!), p), sel, moved: false }
      } else drag.current = { kind: 'vhandle', id: n.id, orig: cloneSubs(editSubs(n)), index: hit.index, which: hit.which, moved: false }
      return
    }

    if (tool === 'move' && st.mode === 'prototype') {
      const h = protoHandle(st)
      if (h && Math.hypot(h.x - sx, h.y - sy) <= 10) {
        drag.current = { kind: 'proto', from: st.selection[0] }
        patchState({ protoDrag: { from: st.selection[0], to: p, target: null }, hover: null })
        return
      }
    }

    if (tool === 'pencil') {
      patchState({ pencil: [p] })
      drag.current = { kind: 'pencil' }
      return
    }

    // Deferred so the composer's input is focused after the browser finishes handling this mousedown.
    if (tool === 'comment') return void setTimeout(() => onCommentAt(p), 0)

    if (tool === 'pen') {
      const pen = st.pen ?? { points: [], cursor: null }
      const first = pen.points[0]
      if (first && pen.points.length >= 2 && Math.hypot(first.x - p.x, first.y - p.y) < 8 / st.viewport.zoom) return finishPen(true)
      patchState({ pen: { points: [...pen.points, { x: p.x, y: p.y, hx: 0, hy: 0 }], cursor: null } })
      drag.current = { kind: 'pen', index: pen.points.length }
      return
    }

    if (tool === 'text') {
      const path = hitPath(st, p)
      const leaf = path[path.length - 1]
      if (leaf && st.doc.byId.get(leaf)!.type === 'TEXT') return startTextEdit(leaf)
      drag.current = { kind: 'text', start: p, sx, sy }
      return
    }

    const shape = SHAPE_TOOLS[tool]
    if (shape) {
      const pl = placement(p)
      const node = makeNode(shape, { parentId: pl.parentId, x: pl.local.x, y: pl.local.y, width: 0, height: 0, ...(tool === 'arrow' ? { arrowEnd: true, name: 'Arrow' } : {}) })
      node.order = nextOrder(st.doc, pl.parentId ?? ROOT)
      setDraft({}, [node])
      select([node.id])
      drag.current = { kind: 'create', type: shape, start: p, id: node.id, pm: pl.world, moved: false }
      return
    }

    // Move tool
    const h = handleAt(sx, sy)
    if (h) {
      const box = selectionBox(st)!
      const ids = topLevelOnly(st.doc, st.selection)
      const all = ids.flatMap((id) => [id, ...descendants(st.doc, id)])
      const world = new Map(ids.map((id) => [id, st.world.get(id)!]))
      const pm = new Map(ids.map((id) => [id, parentWorld(st, id)]))
      if (h.type === 'resize')
        drag.current = { kind: 'resize', handle: h.handle, box, ids, orig: new Map(all.map((id) => [id, st.doc.byId.get(id)!])), world, pm }
      else {
        const c = apply(box.m, { x: box.w / 2, y: box.h / 2 })
        drag.current = { kind: 'rotate', center: c, startAngle: Math.atan2(p.y - c.y, p.x - c.x), ids, world, pm }
      }
      return
    }
    const label = labelAt(sx, sy, ref.current!.getContext('2d')!)
    const hit = label ?? pick(st, p, e.ctrlKey || e.metaKey)
    if (!hit) {
      if (!e.shiftKey) select([])
      drag.current = { kind: 'marquee', start: p, base: e.shiftKey ? st.selection : [], clickSelect: null, moved: false }
      return
    }
    if (e.shiftKey) {
      select(st.selection.includes(hit) ? st.selection.filter((id) => id !== hit) : [...st.selection, hit])
      return
    }
    const already = st.selection.includes(hit)
    const n = st.doc.byId.get(hit)!
    // Dragging from the empty area of a populated top-level frame draws a marquee instead of moving it.
    if (!label && !already && n.type === 'FRAME' && !n.parentId && kids(st.doc, hit).length) {
      select([])
      drag.current = { kind: 'marquee', start: p, base: [], clickSelect: hit, moved: false }
      return
    }
    if (!already) select([hit])
    beginMove(already ? st.selection : [hit], p, sx, sy, already && st.selection.length > 1 ? hit : null)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { sx, sy } = pos(e)
    const st = S()
    const p = screenToWorld(sx, sy)
    onCursor(p)
    const d = drag.current
    if (!d) {
      if (st.tool === 'pen' && st.pen) patchState({ pen: { ...st.pen, cursor: p } })
      if (st.tool === 'hand' || st.spaceDown) return setCursor('grab')
      if (st.editingId) return setCursor(textIndexAt(p) !== null ? 'text' : 'default')
      if (st.vedit) {
        const hit = vectorHit(sx, sy)
        return setCursor(hit ? (hit.type === 'segment' ? 'copy' : 'pointer') : 'default')
      }
      if (st.tool === 'move' && st.mode === 'prototype') {
        const ph = protoHandle(st)
        if (ph && Math.hypot(ph.x - sx, ph.y - sy) <= 10) return setCursor('crosshair')
      }
      if (st.tool !== 'move') {
        if (st.hover) patchState({ hover: null })
        return setCursor(st.tool === 'text' ? 'text' : 'crosshair')
      }
      const h = handleAt(sx, sy)
      if (h) {
        setCursor(h.type === 'rotate' ? ROTATE_CURSOR : resizeCursor(h.handle, h.angle))
        if (st.hover) patchState({ hover: null })
        return
      }
      setCursor('default')
      const hover = labelAt(sx, sy, ref.current!.getContext('2d')!) ?? pick(st, p, e.ctrlKey || e.metaKey)
      if (hover !== st.hover) patchState({ hover })
      return
    }

    switch (d.kind) {
      case 'pan':
        patchState({ viewport: { ...st.viewport, x: d.vx + sx - d.sx, y: d.vy + sy - d.sy } })
        return
      case 'pen': {
        const pts = [...st.pen!.points]
        pts[d.index] = { ...pts[d.index], hx: p.x - pts[d.index].x, hy: p.y - pts[d.index].y }
        patchState({ pen: { points: pts, cursor: null } })
        return
      }
      case 'text':
        patchState({ marquee: boundsOf([d.start, p]) })
        return
      case 'textsel': {
        const idx = textIndexAt(p, 1e7)
        if (idx !== null) setTextSel(d.anchor, idx)
        return
      }
      case 'pencil': {
        const pts = st.pencil ?? []
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) * st.viewport.zoom >= 2) patchState({ pencil: [...pts, p] })
        return
      }
      case 'proto': {
        const top = hitPath(st, p)[0]
        const ok = !!top && st.doc.byId.get(top)!.type === 'FRAME' && top !== d.from && top !== topFrameOf(d.from)
        patchState({ protoDrag: { from: d.from, to: p, target: ok ? top : null } })
        return
      }
      case 'vpoint':
      case 'vhandle': {
        const n = st.rawIndex.byId.get(d.id)
        const m = st.world.get(d.id)
        if (!n || !m) return
        const q = apply(invert(m), p)
        const subs = cloneSubs(d.orig)
        const flat = flatPoints(subs)
        if (d.kind === 'vpoint') {
          let dx = q.x - d.start.x
          let dy = q.y - d.start.y
          if (!d.moved && Math.hypot(dx, dy) * st.viewport.zoom < 2) return
          if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
          for (const i of d.sel) {
            const pt = flat[i]?.p
            if (!pt) continue
            pt.x += dx
            pt.ix += dx
            pt.ox += dx
            pt.y += dy
            pt.iy += dy
            pt.oy += dy
          }
        } else {
          const pt = flat[d.index]?.p
          if (!pt) return
          if (d.which === 'out') {
            pt.ox = q.x
            pt.oy = q.y
            if (!e.altKey) {
              pt.ix = 2 * pt.x - q.x
              pt.iy = 2 * pt.y - q.y
            }
          } else {
            pt.ix = q.x
            pt.iy = q.y
            if (!e.altKey) {
              pt.ox = 2 * pt.x - q.x
              pt.oy = 2 * pt.y - q.y
            }
          }
        }
        d.moved = true
        setDraft({ [d.id]: writeSubs(n, subs) })
        return
      }
      case 'marquee': {
        if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) * st.viewport.zoom < 3) return
        d.moved = true
        const box = boundsOf([d.start, p])
        const hits: string[] = []
        for (const id of kids(st.doc, ROOT)) {
          const n = st.doc.byId.get(id)!
          if (n.locked || n.visible === false) continue
          const b = worldBoxOf(st, id)
          if (!boxesIntersect(b, box)) continue
          if (n.type === 'FRAME' && kids(st.doc, id).length && !boxContains(box, b)) {
            for (const c of kids(st.doc, id)) {
              const cn = st.doc.byId.get(c)!
              if (!cn.locked && cn.visible !== false && boxesIntersect(worldBoxOf(st, c), box)) hits.push(c)
            }
          } else hits.push(id)
        }
        const sel = new Set(d.base)
        for (const id of hits) sel.has(id) ? sel.delete(id) : sel.add(id)
        patchState({ marquee: box, selection: [...sel], hover: null })
        return
      }
      case 'create': {
        d.moved = true
        const inv = invert(d.pm)
        const a = apply(inv, d.start)
        const b = apply(inv, p)
        let patch: Partial<SceneNode>
        if (d.type === 'LINE') {
          let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
          if (e.shiftKey) ang = Math.round(ang / 45) * 45
          patch = { x: a.x, y: a.y, width: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), height: 0, rotation: Math.round(ang * 100) / 100 }
        } else {
          let w = b.x - a.x
          let h = b.y - a.y
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h))
            w = Math.sign(w || 1) * m
            h = Math.sign(h || 1) * m
          }
          let x0 = a.x
          let y0 = a.y
          if (e.altKey) {
            x0 = a.x - w
            y0 = a.y - h
            w *= 2
            h *= 2
          }
          const x1 = Math.round(Math.min(x0, x0 + w))
          const y1 = Math.round(Math.min(y0, y0 + h))
          patch = { x: x1, y: y1, width: Math.max(1, Math.round(Math.abs(w))), height: Math.max(1, Math.round(Math.abs(h))) }
        }
        setDraft({}, st.draftNew.map((n) => (n.id === d.id ? { ...n, ...patch } : n)))
        return
      }
      case 'move': {
        if (!d.moved) {
          if (Math.hypot(sx - d.sx, sy - d.sy) < 3) return
          d.moved = true
          if (e.altKey) {
            const { nodes, idMap } = cloneSubtrees(st.doc, d.ids)
            componentsToInstances(nodes, idMap, d.ids)
            for (const id of d.ids) nodes.find((n) => n.id === idMap.get(id))!.order -= 0.5
            d.dupes = nodes
          }
        }
        let dx = p.x - d.start.x
        let dy = p.y - d.start.y
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
        const flowIds = d.ids.filter((id) => {
          const par = st.doc.byId.get(parentOf(st.doc, id))
          return par && isAutoLayout(par) && d.orig.get(id)!.layoutPositioning !== 'ABSOLUTE'
        })
        let guides = st.guides.length ? [] : st.guides
        if (!e.ctrlKey && !e.metaKey && flowIds.length !== d.ids.length) {
          const snap = snapBox(st, { x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h }, parentOf(st.doc, d.ids[0]), d.exclude, {
            x: !(e.shiftKey && dx === 0),
            y: !(e.shiftKey && dy === 0),
          })
          dx += snap.dx
          dy += snap.dy
          guides = snap.guides
        }
        const draft: Record<string, Partial<SceneNode>> = {}
        for (const id of d.ids) {
          const o = d.orig.get(id)!
          const pm = d.pm.get(id)!
          const lx = o.x + pm[0] * dx + pm[1] * dy
          const ly = o.y + pm[2] * dx + pm[3] * dy
          const straight = !o.rotation && Math.abs(pm[1]) < 1e-6
          draft[id] = { x: straight ? Math.round(lx) : lx, y: straight ? Math.round(ly) : ly }
          if (flowIds.includes(id)) draft[id].layoutPositioning = 'ABSOLUTE'
        }
        setDraft(draft, d.dupes ?? [])
        const tgt = frameAt(S(), p, d.exclude)
        patchState({ guides, hover: null, dropTarget: tgt !== ROOT && tgt !== container(d.ids[0]) ? tgt : flowIds.length && tgt !== ROOT ? tgt : null })
        return
      }
      case 'resize': {
        const { box } = d
        const keep = e.shiftKey || !!box.single?.constrainProportions
        const w0 = box.w
        const h0 = box.h
        const q = apply(invert(box.m), p)
        if (d.handle === 'line-start' || d.handle === 'line-end') {
          const id = d.ids[0]
          const o = d.orig.get(id)!
          const inv = invert(d.pm.get(id)!)
          const fixed = apply(inv, apply(box.m, d.handle === 'line-end' ? { x: 0, y: 0 } : { x: w0, y: 0 }))
          const moving = apply(inv, p)
          const a = d.handle === 'line-end' ? fixed : moving
          const b = d.handle === 'line-end' ? moving : fixed
          let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
          let len = Math.hypot(b.x - a.x, b.y - a.y)
          if (e.shiftKey) {
            ang = Math.round(ang / 45) * 45
          }
          len = Math.max(1, Math.round(len))
          const r = (ang * Math.PI) / 180
          const start = d.handle === 'line-end' ? a : { x: b.x - Math.cos(r) * len, y: b.y - Math.sin(r) * len }
          setDraft({ [id]: { x: start.x, y: start.y, width: len, rotation: Math.round(ang * 100) / 100, height: o.height } })
          return
        }
        let l = 0
        let t = 0
        let r = w0
        let b = h0
        const hd = d.handle
        if (hd.includes('w')) l = q.x
        if (hd.includes('e')) r = q.x
        if (hd.includes('n')) t = q.y
        if (hd.includes('s')) b = q.y
        if (e.altKey) {
          if (hd.includes('w')) r = w0 - l
          if (hd.includes('e')) l = w0 - r
          if (hd.includes('n')) b = h0 - t
          if (hd.includes('s')) t = h0 - b
        }
        if (keep && w0 > 0 && h0 > 0) {
          const corner = hd.length === 2
          const sx2 = Math.abs(r - l) / w0
          const sy2 = Math.abs(b - t) / h0
          const s = corner ? Math.max(sx2, sy2) : hd === 'e' || hd === 'w' ? sx2 : sy2
          const nw = w0 * s
          const nh = h0 * s
          if (corner) {
            if (hd.includes('w')) l = r - nw * Math.sign(r - l || 1)
            else r = l + nw * Math.sign(r - l || 1)
            if (hd.includes('n')) t = b - nh * Math.sign(b - t || 1)
            else b = t + nh * Math.sign(b - t || 1)
          } else if (hd === 'e' || hd === 'w') {
            t = h0 / 2 - nh / 2
            b = h0 / 2 + nh / 2
          } else {
            l = w0 / 2 - nw / 2
            r = w0 / 2 + nw / 2
          }
        }
        if (r < l) [l, r] = [r, l]
        if (b < t) [t, b] = [b, t]
        const straightBox = Math.abs(box.m[1]) < 1e-6
        if (straightBox) {
          // Snap edges to whole pixels in world space.
          l = Math.round(box.m[4] + l) - box.m[4]
          r = Math.round(box.m[4] + r) - box.m[4]
          t = Math.round(box.m[5] + t) - box.m[5]
          b = Math.round(box.m[5] + b) - box.m[5]
        }
        const sxs = w0 ? Math.max(1, r - l) / w0 : 1
        const sys = h0 ? Math.max(1, b - t) / h0 : 1
        const draft: Record<string, Partial<SceneNode>> = {}
        const invBox = invert(box.m)
        const changedW = hd.includes('w') || hd.includes('e') || (keep && hd.length === 1)
        const changedH = hd.includes('n') || hd.includes('s') || (keep && hd.length === 1)
        const scaleKids = (id: string) => {
          for (const c of kids(st.rawIndex, id)) {
            const o = d.orig.get(c)
            if (!o) continue
            draft[c] = { x: o.x * sxs, y: o.y * sys, width: Math.max(1, o.width * sxs), height: o.type === 'LINE' ? 0 : Math.max(1, o.height * sys) }
            if (o.type === 'GROUP') scaleKids(c)
          }
        }
        for (const id of d.ids) {
          const o = d.orig.get(id)!
          const rel = mul(invBox, d.world.get(id)!)
          const nw: Mat = [rel[0], rel[1], rel[2], rel[3], l + rel[4] * sxs, t + rel[5] * sys]
          const local = decompose(mul(invert(d.pm.get(id)!), mul(box.m, nw)))
          const width = Math.max(1, o.width * sxs)
          const height = o.type === 'LINE' ? 0 : Math.max(1, o.height * sys)
          const round = (v: number) => (straightBox ? Math.round(v * 100) / 100 : v)
          draft[id] = { x: round(local.x), y: round(local.y), width: round(width), height: round(height), ...sizeSideEffects(o, changedW, changedH) }
          if (o.type === 'GROUP') scaleKids(id)
        }
        setDraft(draft)
        return
      }
      case 'rotate': {
        let delta = ((Math.atan2(p.y - d.center.y, p.x - d.center.x) - d.startAngle) * 180) / Math.PI
        if (e.shiftKey) delta = Math.round(delta / 15) * 15
        const rot = rotateAround(delta, d.center)
        const draft: Record<string, Partial<SceneNode>> = {}
        for (const id of d.ids) {
          const local = decompose(mul(invert(d.pm.get(id)!), mul(rot, d.world.get(id)!)))
          draft[id] = { x: local.x, y: local.y, rotation: Math.round(local.rotation) === local.rotation ? local.rotation : Math.round(local.rotation * 10) / 10 }
        }
        setDraft(draft)
        return
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const { sx, sy } = pos(e)
    const p = screenToWorld(sx, sy)
    const st = S()
    switch (d.kind) {
      case 'pan':
        setCursor(st.tool === 'hand' || st.spaceDown ? 'grab' : 'default')
        return
      case 'pen':
      case 'textsel':
        return
      case 'pencil':
        return finishPencil()
      case 'proto': {
        const target = st.protoDrag?.target
        patchState({ protoDrag: null })
        if (target) addReaction(d.from, target)
        return
      }
      case 'vpoint':
      case 'vhandle':
        if (d.moved) commitVectorEdit()
        return
      case 'marquee':
        patchState({ marquee: null })
        if (!d.moved && d.clickSelect) select([d.clickSelect])
        return
      case 'text': {
        patchState({ marquee: null })
        const dragged = Math.hypot(sx - d.sx, sy - d.sy) > 5
        const b = boundsOf([d.start, p])
        const pl = placement(dragged ? { x: b.x, y: b.y } : d.start)
        const node = makeNode('TEXT', {
          parentId: pl.parentId,
          x: Math.round(pl.local.x),
          y: Math.round(pl.local.y),
          width: dragged ? Math.round(b.w) : 1,
          height: 15,
          textAutoResize: dragged ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
        })
        setDraft({}, [node])
        startTextEdit(node.id)
        return
      }
      case 'create': {
        let node = st.draftNew.find((n) => n.id === d.id)
        if (!node) return clearDraft()
        if (!d.moved || (node.width <= 1 && node.height <= 1)) {
          const a = apply(invert(d.pm), d.start)
          node = { ...node, x: Math.round(a.x), y: Math.round(a.y), width: 100, height: d.type === 'LINE' ? 0 : 100 }
        }
        commit([{ op: 'create', node }], { select: [node.id] })
        setTool('move')
        return
      }
      case 'move': {
        if (!d.moved) {
          if (d.clickId) select([d.clickId])
          return
        }
        const cur = S()
        const tgt = frameAt(cur, p, d.exclude)
        const ops: Op[] = (d.dupes ?? []).map((n) => ({ op: 'create', node: n }))
        const tgtNode = cur.doc.byId.get(tgt)
        const adopt: string[] = []
        const emptied = new Set<string>()
        for (const id of d.ids) {
          const o = d.orig.get(id)!
          const par = cur.doc.byId.get(parentOf(cur.doc, id))
          const wasFlow = !!par && isAutoLayout(par) && o.layoutPositioning !== 'ABSOLUTE'
          if (tgt !== container(id)) {
            adopt.push(id)
            const local = decompose(mul(invert(tgt === ROOT ? [1, 0, 0, 1, 0, 0] : cur.world.get(tgt)!), cur.world.get(id)!))
            ops.push({
              op: 'update',
              id,
              patch: { parentId: tgt === ROOT ? null : tgt, x: Math.round(local.x * 100) / 100, y: Math.round(local.y * 100) / 100, rotation: local.rotation || null },
            })
            if (par?.type === 'GROUP' && kids(cur.doc, par.id).every((k) => d.ids.includes(k))) emptied.add(par.id)
          } else if (wasFlow) adopt.push(id)
          else ops.push({ op: 'update', id, patch: { x: cur.draft[id]?.x ?? o.x, y: cur.draft[id]?.y ?? o.y } })
        }
        if (adopt.length) {
          const moving = new Set(adopt)
          const rest = kids(cur.doc, tgt).filter((k) => !moving.has(k) && !(d.dupes ?? []).some((n) => n.id === k))
          const at = tgtNode && isAutoLayout(tgtNode) ? Math.min(flowIndex(tgt, p, new Set([...moving, ...(d.dupes ?? []).map((n) => n.id)])), rest.length) : rest.length
          const ordered = [...rest.slice(0, at), ...adopt, ...rest.slice(at)]
          ordered.forEach((id, i) => ops.push({ op: 'update', id, patch: { order: i } }))
        }
        for (const g of emptied) ops.push({ op: 'delete', id: g })
        commit(ops)
        return
      }
      case 'resize':
      case 'rotate':
        patchState({ guides: [] })
        commitDraft()
        return
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const { sx, sy } = pos(e)
    const st = S()
    const p = screenToWorld(sx, sy)
    if (st.tool === 'pen') return finishPen(false)
    if (st.vedit) {
      const hit = vectorHit(sx, sy)
      if (hit?.type === 'anchor') toggleSmooth(hit.index)
      return
    }
    if (st.tool !== 'move' || st.editingId) return
    const path = hitPath(st, p)
    if (!path.length) return
    const leaf = path[path.length - 1]
    const deeper = pickDeeper(st, p)
    if (st.doc.byId.get(leaf)!.type === 'VECTOR' && (st.selection.includes(leaf) || deeper === leaf)) return enterVectorEdit(leaf)
    if (st.doc.byId.get(leaf)!.type === 'TEXT' && (st.selection.includes(leaf) || deeper === leaf)) return startTextEdit(leaf)
    if (deeper) select([deeper])
  }

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault()
    const { sx, sy } = pos(e)
    const st = S()
    const p = screenToWorld(sx, sy)
    const hit = pick(st, p)
    if (hit && !st.selection.includes(hit)) select([hit])
    if (!hit) select([])
    onContextMenu(e.clientX, e.clientY, p)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const { sx, sy } = pos(e)
    const p = screenToWorld(sx, sy)
    const comp = e.dataTransfer.getData('application/x-figclone-component')
    if (comp) return void createInstance(comp, p)
    for (const f of Array.from(e.dataTransfer.files)) if (f.type.startsWith('image/')) void placeImage(f, p, f.name.replace(/\.\w+$/, ''))
  }

  return (
    <div ref={wrap} className="canvas-wrap">
      <canvas
        ref={ref}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onMouseDown={(e) => S().editingId && e.preventDefault()}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => !drag.current && S().hover && patchState({ hover: null })}
        onDoubleClick={onDoubleClick}
        onContextMenu={onCtx}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      />
      <TextProxy />
    </div>
  )
}

/** Invisible textarea that receives typing for the text node being edited; the caret is drawn on the canvas. */
function TextProxy() {
  const id = useEditor((s) => s.editingId)
  const value = useEditor((s) => (s.editingId ? (s.doc.byId.get(s.editingId)?.characters ?? '') : ''))
  const m = useEditor((s) => (s.editingId ? s.world.get(s.editingId) : undefined))
  const vp = useEditor((s) => s.viewport)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!id) return
    const el = ta.current
    if (!el) return
    registerProxy(el)
    el.focus({ preventScroll: true })
    const sel = S().textSel
    if (sel) el.setSelectionRange(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end))
    const blink = setInterval(() => patchState({ caretOn: !S().caretOn }), 530)
    document.addEventListener('selectionchange', syncSelFromProxy)
    // Selecting something else (layers panel, an agent, undo) ends the edit.
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.selection !== prev.selection && s.editingId && (s.selection.length !== 1 || s.selection[0] !== s.editingId)) finishTextEdit()
    })
    return () => {
      clearInterval(blink)
      document.removeEventListener('selectionchange', syncSelFromProxy)
      unsub()
      registerProxy(null)
    }
  }, [id])
  if (!id || !m) return null
  return (
    <textarea
      ref={ta}
      className="text-proxy"
      value={value}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => {
        applyTextInput(e.target.value)
        syncSelFromProxy()
      }}
      onSelect={syncSelFromProxy}
      onKeyUp={syncSelFromProxy}
      onBlur={(e) => {
        // Keep editing while the user adjusts properties of the selected characters.
        const to = e.relatedTarget as HTMLElement | null
        if (to?.closest('.right, .popover, .menu, .palette')) return
        finishTextEdit()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        const mod = e.ctrlKey || e.metaKey
        if (e.key === 'Escape') {
          e.preventDefault()
          finishTextEdit()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          moveCaretVertical(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey)
        } else if ((e.key === 'Home' || e.key === 'End') && !mod) {
          e.preventDefault()
          moveCaretLineEdge(e.key === 'End', e.shiftKey)
        } else if (mod && !e.altKey) {
          const k = e.key.toLowerCase()
          const kind = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'u' ? 'underline' : null
          if (kind) {
            e.preventDefault()
            toggleTextStyle(kind)
          }
        }
      }}
      style={{ left: m[4] * vp.zoom + vp.x, top: m[5] * vp.zoom + vp.y }}
    />
  )
}
