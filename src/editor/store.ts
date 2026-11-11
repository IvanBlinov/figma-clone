import { create } from 'zustand'
import { applyOpsToList, buildIndex, computeWorld, type DocIndex } from '../../shared/doc'
import type { Box, Mat, Pt } from '../../shared/geometry'
import { runLayout } from '../../shared/layout'
import { applyConstraints, resolveOps } from '../../shared/resolve'
import type { Op, SceneNode } from '../../shared/types'
import { ensureFont, fontsPending, measureText, onFontsChanged } from './fonts'

export type Tool =
  | 'move'
  | 'hand'
  | 'frame'
  | 'section'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'pen'
  | 'pencil'
  | 'arrow'
  | 'text'
  | 'comment'

export interface Viewport {
  x: number
  y: number
  zoom: number
}
export interface PenPoint {
  x: number
  y: number
  hx: number // out-handle offset (in-handle is mirrored)
  hy: number
}
export interface Guide {
  x1: number
  y1: number
  x2: number
  y2: number
}
interface HistoryEntry {
  undo: Op[]
  redo: Op[]
  selBefore: string[]
  selAfter: string[]
}

export interface EditorState {
  pageId: string | null
  pageBg: string
  /** Nodes as stored (server state + optimistic local ops). */
  raw: SceneNode[]
  rawIndex: DocIndex
  /** In-flight edits (drag, resize, typing) layered over `raw` until committed. */
  draft: Record<string, Partial<SceneNode>>
  draftNew: SceneNode[]
  /** Laid-out document used for rendering and hit-testing. */
  doc: DocIndex
  world: Map<string, Mat>
  selection: string[]
  hover: string | null
  tool: Tool
  viewport: Viewport
  canvasSize: { w: number; h: number }
  editingId: string | null
  guides: Guide[]
  marquee: Box | null
  dropTarget: string | null
  pen: { points: PenPoint[]; cursor: Pt | null } | null
  /** Freehand stroke being drawn (world points). */
  pencil: Pt[] | null
  /** Right-panel mode. */
  mode: 'design' | 'prototype' | 'inspect'
  /** Vector point editing: node id and selected anchor indices (flattened across subpaths). */
  vedit: { id: string; sel: number[] } | null
  /** Caret / selection inside the text node being edited. */
  textSel: { start: number; end: number } | null
  caretOn: boolean
  showGrids: boolean
  showRulers: boolean
  altDown: boolean
  /** Prototype connection being dragged. */
  protoDrag: { from: string; to: Pt; target: string | null } | null
  paletteOpen: boolean
  /** The viewer may look but not change the document. */
  readOnly: boolean
  uiHidden: boolean
  spaceDown: boolean
  showComments: boolean
  canUndo: boolean
  canRedo: boolean
  tick: number
}

const emptyIndex = buildIndex([])

export const useEditor = create<EditorState>(() => ({
  pageId: null,
  pageBg: '#F5F5F5',
  raw: [],
  rawIndex: emptyIndex,
  draft: {},
  draftNew: [],
  doc: emptyIndex,
  world: new Map(),
  selection: [],
  hover: null,
  tool: 'move',
  viewport: { x: 0, y: 0, zoom: 1 },
  canvasSize: { w: 800, h: 600 },
  editingId: null,
  guides: [],
  marquee: null,
  dropTarget: null,
  pen: null,
  pencil: null,
  mode: 'design',
  vedit: null,
  textSel: null,
  caretOn: true,
  showGrids: true,
  showRulers: false,
  altDown: false,
  protoDrag: null,
  paletteOpen: false,
  readOnly: false,
  uiHidden: false,
  spaceDown: false,
  showComments: true,
  canUndo: false,
  canRedo: false,
  tick: 0,
}))

export const S = useEditor.getState
const set = useEditor.setState

let remote: (ops: Op[]) => void = () => {}
/** Connects the store to the backend mutation. */
export function bindRemote(fn: (ops: Op[]) => void) {
  remote = fn
}

let history: { undo: HistoryEntry[]; redo: HistoryEntry[] } = { undo: [], redo: [] }

function merged(raw: SceneNode[], draft: EditorState['draft'], draftNew: SceneNode[]): SceneNode[] {
  let list = raw
  if (draftNew.length) list = [...raw, ...draftNew]
  if (Object.keys(draft).length) list = list.map((n) => (draft[n.id] ? ({ ...n, ...draft[n.id] } as SceneNode) : n))
  return list
}

function derive(raw: SceneNode[], draft: EditorState['draft'], draftNew: SceneNode[]) {
  for (const n of raw) if (n.type === 'TEXT') ensureFont(n.fontFamily ?? 'Inter', n.fontWeight ?? 400, !!n.italic)
  let list = merged(raw, draft, draftNew)
  const keys = Object.keys(draft)
  if (keys.length) {
    // Preview constraint-driven moves while a frame is being resized.
    const explicit = new Map(keys.map((id) => [id, new Set(Object.keys(draft[id]))]))
    list = applyConstraints(raw, list, explicit)
  }
  const res = runLayout(list, measureText)
  return { doc: res.index, world: computeWorld(res.index), patches: res.patches }
}

let syncTimer: ReturnType<typeof setTimeout> | undefined
/** Persist layout results that differ from stored geometry (fonts loaded, agent edits, …). */
function scheduleLayoutSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const st = S()
    if (Object.keys(st.draft).length || st.draftNew.length || fontsPending() || !st.pageId || st.readOnly) return
    const { patches } = runLayout(st.raw, measureText)
    if (!patches.length) return
    const ops: Op[] = patches.map((p) => ({ op: 'update', id: p.id, patch: p.patch as Record<string, unknown> }))
    remote(ops)
  }, 400)
}

/** New server snapshot for the current page. */
export function setRaw(pageId: string, nodes: SceneNode[]) {
  const st = S()
  const d = derive(nodes, st.draft, st.draftNew)
  const ids = d.doc.byId
  set({
    pageId,
    raw: nodes,
    rawIndex: buildIndex(nodes),
    doc: d.doc,
    world: d.world,
    selection: st.selection.every((id) => ids.has(id)) ? st.selection : st.selection.filter((id) => ids.has(id)),
    hover: st.hover && ids.has(st.hover) ? st.hover : null,
  })
  if (d.patches.length) scheduleLayoutSync()
}

export function setDraft(draft: EditorState['draft'], draftNew?: SceneNode[]) {
  const st = S()
  const dn = draftNew ?? st.draftNew
  const d = derive(st.raw, draft, dn)
  set({ draft, draftNew: dn, doc: d.doc, world: d.world })
}

export function clearDraft() {
  const st = S()
  if (Object.keys(st.draft).length || st.draftNew.length) setDraft({}, [])
}

onFontsChanged(() => {
  const st = S()
  const d = derive(st.raw, st.draft, st.draftNew)
  set({ doc: d.doc, world: d.world, tick: st.tick + 1 })
  if (d.patches.length) scheduleLayoutSync()
})

function invertOps(ops: Op[], nodes: SceneNode[]): Op[] {
  const map = new Map(nodes.map((n) => [n.id, n]))
  const inv: Op[] = []
  for (const op of ops) {
    if (op.op === 'create') {
      const prev = map.get(op.node.id)
      inv.unshift(prev ? { op: 'create', node: prev } : { op: 'delete', id: op.node.id })
      map.set(op.node.id, op.node)
    } else if (op.op === 'update') {
      const cur = map.get(op.id) as unknown as Record<string, unknown> | undefined
      if (!cur) continue
      const before: Record<string, unknown> = {}
      const next = { ...cur }
      for (const [k, v] of Object.entries(op.patch)) {
        before[k] = cur[k] === undefined ? null : cur[k]
        if (v === null || v === undefined) delete next[k]
        else next[k] = v
      }
      inv.unshift({ op: 'update', id: op.id, patch: before })
      map.set(op.id, next as unknown as SceneNode)
    } else {
      const cur = map.get(op.id)
      if (cur) inv.unshift({ op: 'create', node: cur })
      map.delete(op.id)
    }
  }
  return inv
}

function applyLocal(ops: Op[], selection?: string[]) {
  const st = S()
  const raw = applyOpsToList(st.raw, ops)
  const d = derive(raw, {}, [])
  const sel = (selection ?? st.selection).filter((id) => d.doc.byId.has(id))
  set({
    raw,
    rawIndex: buildIndex(raw),
    draft: {},
    draftNew: [],
    doc: d.doc,
    world: d.world,
    selection: sel,
    guides: [],
    dropTarget: null,
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
  })
  remote(ops)
}

/**
 * Apply document ops: updates local state immediately, records undo history and sends them to the backend.
 * Derived layout changes are folded into the same batch so undo restores them too.
 */
export function commit(ops: Op[], opts: { select?: string[]; history?: boolean } = {}) {
  const st = S()
  if (!st.pageId) return
  if (st.readOnly) return clearDraft()
  if (!ops.length) {
    clearDraft()
    if (opts.select) set({ selection: opts.select })
    return
  }
  const all = resolveOps(st.raw, ops, measureText).ops
  if (opts.history !== false) {
    history.undo.push({
      undo: invertOps(all, st.raw),
      redo: all,
      selBefore: st.selection,
      selAfter: opts.select ?? st.selection,
    })
    if (history.undo.length > 200) history.undo.shift()
    history.redo = []
  }
  applyLocal(all, opts.select)
}

export function undo() {
  const e = history.undo.pop()
  if (!e) return
  history.redo.push(e)
  set({ editingId: null, vedit: null, textSel: null })
  applyLocal(e.undo, e.selBefore)
}

export function redo() {
  const e = history.redo.pop()
  if (!e) return
  history.undo.push(e)
  set({ editingId: null, vedit: null, textSel: null })
  applyLocal(e.redo, e.selAfter)
}

/** Forget undo history (after the document was replaced wholesale, e.g. a version restore). */
export function clearHistory() {
  history = { undo: [], redo: [] }
  set({ canUndo: false, canRedo: false })
}

export function resetEditor() {
  history = { undo: [], redo: [] }
  set({
    pageId: null,
    raw: [],
    rawIndex: emptyIndex,
    draft: {},
    draftNew: [],
    doc: emptyIndex,
    world: new Map(),
    selection: [],
    hover: null,
    editingId: null,
    guides: [],
    marquee: null,
    pen: null,
    pencil: null,
    vedit: null,
    textSel: null,
    protoDrag: null,
    tool: 'move',
    canUndo: false,
    canRedo: false,
  })
}

export const select = (ids: string[]) => set({ selection: ids })
export const setTool = (tool: Tool) => {
  if (S().readOnly && tool !== 'move' && tool !== 'hand' && tool !== 'comment') return
  set({ tool, pen: null, pencil: null, vedit: null })
}
export const patchState = set

export const screenToWorld = (sx: number, sy: number, vp = S().viewport): Pt => ({
  x: (sx - vp.x) / vp.zoom,
  y: (sy - vp.y) / vp.zoom,
})
export const worldToScreen = (p: Pt, vp = S().viewport): Pt => ({ x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y })

// Handy for debugging from the browser console.
if (import.meta.env.DEV) (window as unknown as { __editor: unknown }).__editor = useEditor
