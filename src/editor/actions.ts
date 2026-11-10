import {
  ancestors,
  cloneSubtrees,
  descendants,
  kids,
  nextOrder,
  parentOf,
  ROOT,
  sortByDocOrder,
  topLevelOnly,
  uniqueName,
} from '../../shared/doc'
import { boundsOf, corners, decompose, invert, mul, translate, unionBoxes, type Box, type Mat, type Pt } from '../../shared/geometry'
import { outlineSubs } from '../../shared/boolean'
import { cssText } from '../../shared/css'
import { exportSvg } from '../../shared/svg'
import { cleanRuns, styleRange } from '../../shared/text'
import { defaultsFor, isAutoLayout, newId, type BooleanOp, type NodeType, type Op, type Reaction, type SceneNode, type TextRunStyle } from '../../shared/types'
import { serializePath, subsBounds, transformSubs, type SubPath } from '../../shared/vector'
import { measureText } from './fonts'
import { frameAt, parentWorld, worldBoxOf } from './hit'
import { renderToCanvas } from './render'
import { commit, patchState, S, screenToWorld, setDraft } from './store'

const IDM: Mat = [1, 0, 0, 1, 0, 0]
const worldOf = (id: string): Mat => (id === ROOT ? IDM : (S().world.get(id) ?? IDM))
const node = (id: string) => S().doc.byId.get(id)

export function makeNode(type: NodeType, props: Partial<SceneNode>): SceneNode {
  return {
    id: newId(),
    order: 0,
    type,
    name: uniqueName(S().doc, type),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...defaultsFor(type),
    ...props,
  } as SceneNode
}

/** Local transform a node needs under `newParent` to keep its current place on the canvas. */
export function relocate(id: string, newParent: string): { x: number; y: number; rotation: number } {
  return decompose(mul(invert(worldOf(newParent)), worldOf(id)))
}

/** Ops giving `ordered` consecutive order values. Nodes in `fresh` are not yet stored and are mutated instead. */
function arrange(ordered: string[], fresh?: Map<string, SceneNode>): Op[] {
  const ops: Op[] = []
  ordered.forEach((id, i) => {
    const f = fresh?.get(id)
    if (f) f.order = i
    else if (node(id)?.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
  })
  return ops
}

function worldDeltaPatch(id: string, dx: number, dy: number): Partial<SceneNode> {
  const pm = parentWorld(S(), id)
  const n = node(id)!
  return { x: n.x + pm[0] * dx + pm[1] * dy, y: n.y + pm[2] * dx + pm[3] * dy }
}

const inFlow = (id: string) => {
  const n = node(id)
  const p = n && node(parentOf(S().doc, id))
  return !!(n && p && isAutoLayout(p) && n.layoutPositioning !== 'ABSOLUTE')
}

// ---------- property edits ----------
export function preview(ids: string[], patch: Partial<SceneNode> | ((n: SceneNode) => Partial<SceneNode>)) {
  const st = S()
  const draft = { ...st.draft }
  let fresh = st.draftNew
  for (const id of ids) {
    const n = node(id)
    if (!n) continue
    const p = typeof patch === 'function' ? patch(n) : patch
    if (fresh.some((d) => d.id === id)) {
      // Node that is still being created (e.g. new text): edit it in place.
      fresh = fresh.map((d) => {
        if (d.id !== id) return d
        const next = { ...d, ...p } as unknown as Record<string, unknown>
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        return next as unknown as SceneNode
      })
    } else draft[id] = { ...draft[id], ...p }
  }
  setDraft(draft, fresh)
}

export function commitDraft() {
  const st = S()
  if (!Object.keys(st.draft).length) return
  const ops: Op[] = []
  for (const [id, patch] of Object.entries(st.draft)) {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) clean[k] = v === undefined ? null : v
    ops.push({ op: 'update', id, patch: clean })
  }
  commit(ops)
}

export function update(ids: string[], patch: Partial<SceneNode> | ((n: SceneNode) => Partial<SceneNode>)) {
  preview(ids, patch)
  commitDraft()
}

/** Extra props implied by a manual size change (text boxes stop auto-sizing, hug/fill becomes fixed). */
export function sizeSideEffects(n: SceneNode, w: boolean, h: boolean): Partial<SceneNode> {
  const p: Partial<SceneNode> = {}
  if (n.type === 'TEXT') {
    const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
    if (h) p.textAutoResize = 'NONE'
    else if (w && mode === 'WIDTH_AND_HEIGHT') p.textAutoResize = 'HEIGHT'
  }
  if (w && n.layoutSizingHorizontal && n.layoutSizingHorizontal !== 'FIXED') p.layoutSizingHorizontal = 'FIXED'
  if (h && n.layoutSizingVertical && n.layoutSizingVertical !== 'FIXED') p.layoutSizingVertical = 'FIXED'
  return p
}

// ---------- structure ----------
export function deleteNodes(ids: string[]) {
  const { doc } = S()
  const gone = new Set<string>()
  for (const id of topLevelOnly(doc, ids)) {
    gone.add(id)
    for (const d of descendants(doc, id)) gone.add(d)
    // Remove groups that would be left empty.
    let p = parentOf(doc, id)
    while (p !== ROOT && node(p)?.type === 'GROUP' && kids(doc, p).every((k) => gone.has(k))) {
      gone.add(p)
      p = parentOf(doc, p)
    }
  }
  commit(
    [...gone].map((id) => ({ op: 'delete', id })),
    { select: [] },
  )
}

export const deleteSelection = () => deleteNodes(S().selection)

export function duplicateSelection() {
  const { doc, selection } = S()
  const roots = topLevelOnly(doc, selection)
  if (!roots.length) return
  const { nodes, idMap } = cloneSubtrees(doc, roots)
  componentsToInstances(nodes, idMap, roots)
  const fresh = new Map(nodes.map((n) => [n.id, n]))
  const ops: Op[] = []
  const parents = new Set(roots.map((id) => parentOf(doc, id)))
  for (const p of parents) {
    const ordered: string[] = []
    for (const k of kids(doc, p)) {
      ordered.push(k)
      if (roots.includes(k)) ordered.push(idMap.get(k)!)
    }
    ops.push(...arrange(ordered, fresh))
  }
  commit([...nodes.map((n) => ({ op: 'create' as const, node: n })), ...ops], { select: roots.map((id) => idMap.get(id)!) })
}

export function wrapSelection(type: 'GROUP' | 'FRAME', extra: Partial<SceneNode> = {}): string | null {
  const { doc, selection } = S()
  const ids = sortByDocOrder(doc, topLevelOnly(doc, selection))
  if (!ids.length) return null
  const front = ids[ids.length - 1]
  const parent = parentOf(doc, front)
  const rel = new Map(ids.map((id) => [id, mul(invert(worldOf(parent)), worldOf(id))]))
  const b = boundsOf(ids.flatMap((id) => corners(rel.get(id)!, node(id)!.width, node(id)!.height)))
  const wrapper = makeNode(type, {
    parentId: parent === ROOT ? undefined : parent,
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    ...(type === 'FRAME' ? { fills: [], clipsContent: false } : {}),
    ...extra,
  })
  const ops: Op[] = [{ op: 'create', node: wrapper }]
  ids.forEach((id, i) => {
    const d = decompose(mul(translate(-b.x, -b.y), rel.get(id)!))
    ops.push({ op: 'update', id, patch: { parentId: wrapper.id, x: d.x, y: d.y, rotation: d.rotation || null, order: i } })
  })
  const moved = new Set(ids)
  const ordered = kids(doc, parent).flatMap((k) => (k === front ? [wrapper.id] : moved.has(k) ? [] : [k]))
  ops.push(...arrange(ordered, new Map([[wrapper.id, wrapper]])))
  commit(ops, { select: [wrapper.id] })
  return wrapper.id
}

export function ungroupSelection() {
  const { doc, selection } = S()
  const ops: Op[] = []
  const sel: string[] = []
  for (const id of selection) {
    const g = node(id)
    if (!g || (g.type !== 'GROUP' && g.type !== 'FRAME')) continue
    const parent = parentOf(doc, id)
    const children = kids(doc, id)
    if (!children.length) continue
    for (const c of children) {
      const d = relocate(c, parent)
      ops.push({ op: 'update', id: c, patch: { parentId: parent === ROOT ? null : parent, x: d.x, y: d.y, rotation: d.rotation || null } })
      sel.push(c)
    }
    ops.push({ op: 'delete', id })
    ops.push(...arrange(kids(doc, parent).flatMap((k) => (k === id ? children : [k]))))
  }
  if (ops.length) commit(ops, { select: sel })
}

export function addAutoLayout() {
  const st = S()
  let target = st.selection.length === 1 ? node(st.selection[0]) : undefined
  let wrapped = false
  if (!target || target.type !== 'FRAME' || isAutoLayout(target)) {
    if (!st.selection.length) return
    const id = wrapSelection('FRAME')
    if (!id) return
    target = S().doc.byId.get(id)!
    wrapped = true
  }
  const doc = S().doc
  const children = kids(doc, target.id).map((c) => doc.byId.get(c)!)
  const horizontal =
    children.length > 1
      ? Math.max(...children.map((c) => c.x)) - Math.min(...children.map((c) => c.x)) >=
        Math.max(...children.map((c) => c.y)) - Math.min(...children.map((c) => c.y))
      : true
  const sorted = [...children].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y))
  let gap = 10
  if (sorted.length > 1) {
    let total = 0
    for (let i = 1; i < sorted.length; i++)
      total += horizontal ? sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width) : sorted[i].y - (sorted[i - 1].y + sorted[i - 1].height)
    gap = Math.max(0, Math.round(total / (sorted.length - 1)))
  }
  const b = children.length
    ? unionBoxes(children.map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })))
    : { x: 0, y: 0, w: target.width, h: target.height }
  const pad = wrapped ? 10 : null
  const ops: Op[] = [
    {
      op: 'update',
      id: target.id,
      patch: {
        layoutMode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
        itemSpacing: gap,
        paddingLeft: pad ?? Math.max(0, Math.round(b.x)),
        paddingTop: pad ?? Math.max(0, Math.round(b.y)),
        paddingRight: pad ?? Math.max(0, Math.round(target.width - b.x - b.w)),
        paddingBottom: pad ?? Math.max(0, Math.round(target.height - b.y - b.h)),
        layoutSizingHorizontal: 'HUG',
        layoutSizingVertical: 'HUG',
        counterAxisAlignItems: 'MIN',
        primaryAxisAlignItems: 'MIN',
        ...(wrapped ? { x: target.x - 10, y: target.y - 10 } : {}),
      },
    },
    ...sorted.map((c, i) => ({ op: 'update' as const, id: c.id, patch: { order: i } })),
  ]
  // Merge with the wrap step so one undo reverts both.
  commit(ops, { select: [target.id] })
}

export function removeAutoLayout(id: string) {
  update([id], { layoutMode: 'NONE', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' })
}

/** Move nodes to another parent / position in the layer stack, preserving their place on canvas. */
export function moveNodes(ids: string[], newParent: string, index?: number, extraPatch?: (id: string) => Partial<SceneNode>) {
  const { doc } = S()
  const moving = sortByDocOrder(doc, topLevelOnly(doc, ids)).filter(
    (id) => id !== newParent && !ancestors(doc, newParent).includes(id),
  )
  if (!moving.length) return
  const set = new Set(moving)
  const ops: Op[] = []
  const emptied = new Set<string>()
  for (const id of moving) {
    const cur = parentOf(doc, id)
    const patch: Record<string, unknown> = { ...(extraPatch?.(id) ?? {}) }
    if (cur !== newParent) {
      const d = relocate(id, newParent)
      Object.assign(patch, { parentId: newParent === ROOT ? null : newParent, x: d.x, y: d.y, rotation: d.rotation || null, ...(extraPatch?.(id) ?? {}) })
      if (node(cur)?.type === 'GROUP' && kids(doc, cur).every((k) => set.has(k))) emptied.add(cur)
    }
    if (Object.keys(patch).length) ops.push({ op: 'update', id, patch })
  }
  const rest = kids(doc, newParent).filter((k) => !set.has(k))
  const at = index == null ? rest.length : Math.max(0, Math.min(index, rest.length))
  ops.push(...arrange([...rest.slice(0, at), ...moving, ...rest.slice(at)]))
  for (const g of emptied) ops.push({ op: 'delete', id: g })
  commit(ops, { select: moving })
}

export function reorderSelection(mode: 'front' | 'back' | 'forward' | 'backward') {
  const { doc, selection } = S()
  const roots = topLevelOnly(doc, selection)
  const ops: Op[] = []
  for (const p of new Set(roots.map((id) => parentOf(doc, id)))) {
    const list = [...kids(doc, p)]
    const sel = new Set(roots.filter((id) => parentOf(doc, id) === p))
    let next: string[]
    if (mode === 'front') next = [...list.filter((k) => !sel.has(k)), ...list.filter((k) => sel.has(k))]
    else if (mode === 'back') next = [...list.filter((k) => sel.has(k)), ...list.filter((k) => !sel.has(k))]
    else {
      next = list
      if (mode === 'forward') {
        for (let i = list.length - 2; i >= 0; i--)
          if (sel.has(next[i]) && !sel.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]]
      } else {
        for (let i = 1; i < list.length; i++)
          if (sel.has(next[i]) && !sel.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]]
      }
    }
    ops.push(...arrange(next))
  }
  commit(ops)
}

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export function alignSelection(kind: AlignKind) {
  const st = S()
  const ids = topLevelOnly(st.doc, st.selection).filter((id) => !inFlow(id))
  if (!ids.length) return
  let target: Box
  if (ids.length === 1) {
    const p = parentOf(st.doc, ids[0])
    if (p === ROOT) return
    target = worldBoxOf(st, p)
  } else target = unionBoxes(ids.map((id) => worldBoxOf(st, id)))
  const ops: Op[] = ids.map((id) => {
    const b = worldBoxOf(st, id)
    let dx = 0
    let dy = 0
    if (kind === 'left') dx = target.x - b.x
    if (kind === 'hcenter') dx = target.x + target.w / 2 - (b.x + b.w / 2)
    if (kind === 'right') dx = target.x + target.w - (b.x + b.w)
    if (kind === 'top') dy = target.y - b.y
    if (kind === 'vcenter') dy = target.y + target.h / 2 - (b.y + b.h / 2)
    if (kind === 'bottom') dy = target.y + target.h - (b.y + b.h)
    return { op: 'update', id, patch: worldDeltaPatch(id, dx, dy) as Record<string, unknown> }
  })
  commit(ops)
}

export function distributeSelection(axis: 'h' | 'v') {
  const st = S()
  const ids = topLevelOnly(st.doc, st.selection).filter((id) => !inFlow(id))
  if (ids.length < 3) return
  const boxes = ids.map((id) => ({ id, b: worldBoxOf(st, id) })).sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y))
  const first = boxes[0].b
  const last = boxes[boxes.length - 1].b
  const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y
  const total = boxes.reduce((s, o) => s + (axis === 'h' ? o.b.w : o.b.h), 0)
  const gap = (span - total) / (boxes.length - 1)
  let cursor = axis === 'h' ? first.x : first.y
  const ops: Op[] = []
  for (const o of boxes) {
    const d = cursor - (axis === 'h' ? o.b.x : o.b.y)
    ops.push({ op: 'update', id: o.id, patch: worldDeltaPatch(o.id, axis === 'h' ? d : 0, axis === 'h' ? 0 : d) as Record<string, unknown> })
    cursor += (axis === 'h' ? o.b.w : o.b.h) + gap
  }
  commit(ops)
}

export function nudge(dx: number, dy: number) {
  const st = S()
  const ids = topLevelOnly(st.doc, st.selection).filter((id) => !inFlow(id) && !node(id)!.locked)
  commit(ids.map((id) => ({ op: 'update', id, patch: worldDeltaPatch(id, dx, dy) as Record<string, unknown> })))
}

export function selectAll() {
  const st = S()
  const first = st.selection[0]
  const parent = first && st.doc.byId.has(first) ? parentOf(st.doc, first) : ROOT
  patchState({ selection: kids(st.doc, parent).filter((id) => !node(id)!.locked && node(id)!.visible !== false) })
}

// ---------- clipboard ----------
interface Clip {
  figclone: 1
  nodes: SceneNode[]
  roots: { id: string; world: Mat; parent: string }[]
}
let memoryClip: Clip | null = null

export function copySelection(): string | null {
  const { doc, selection } = S()
  const roots = sortByDocOrder(doc, topLevelOnly(doc, selection))
  if (!roots.length) return null
  const nodes = roots.flatMap((id) => [id, ...descendants(doc, id)]).map((id) => node(id)!)
  memoryClip = { figclone: 1, nodes, roots: roots.map((id) => ({ id, world: worldOf(id), parent: parentOf(doc, id) })) }
  return JSON.stringify(memoryClip)
}

export function pasteClip(text?: string | null, at?: Pt) {
  let clip = memoryClip
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed?.figclone === 1) clip = parsed
    } catch {
      /* not ours */
    }
  }
  if (!clip) return false
  const st = S()
  const idMap = new Map(clip.nodes.map((n) => [n.id, newId()]))
  const rootSet = new Map(clip.roots.map((r) => [r.id, r]))
  // Where to paste: inside a selected frame, else next to the originals, else page level.
  const sel = st.selection.length === 1 ? node(st.selection[0]) : undefined
  let offset: Pt = { x: 0, y: 0 }
  if (at) {
    const b = unionBoxes(clip.roots.map((r) => boundsOf(corners(r.world, clip!.nodes.find((n) => n.id === r.id)!.width, clip!.nodes.find((n) => n.id === r.id)!.height))))
    offset = { x: at.x - (b.x + b.w / 2), y: at.y - (b.y + b.h / 2) }
  }
  const fresh = new Map<string, SceneNode>()
  const byParent = new Map<string, string[]>()
  // Pasting a main component that still exists on this page makes an instance of it.
  const sourceOf = new Map<string, string>()
  const clipKids = (id: string): string[] => clip!.nodes.filter((c) => c.parentId === id).flatMap((c) => [c.id, ...clipKids(c.id)])
  for (const r of clip.roots) {
    const orig = st.doc.byId.get(r.id)
    if (!orig?.isComponent) continue
    sourceOf.set(r.id, '')
    for (const c of clipKids(r.id)) sourceOf.set(c, c)
  }
  const nodes = clip.nodes
    .filter((n) => !sourceOf.get(n.id) || st.doc.byId.has(n.id))
    .map((n) => {
    const copy: SceneNode = { ...n, id: idMap.get(n.id)! }
    const r = rootSet.get(n.id)
    if (r) {
      let parent: string
      if (at) parent = frameAt(st, at, new Set())
      else if (sel && sel.type === 'FRAME' && !rootSet.has(sel.id)) parent = sel.id
      else parent = st.doc.byId.has(r.parent) ? r.parent : ROOT
      const world = mul(translate(offset.x, offset.y), r.world)
      const d = decompose(mul(invert(worldOf(parent)), world))
      Object.assign(copy, { x: d.x, y: d.y, rotation: d.rotation || undefined })
      if (parent === ROOT) delete copy.parentId
      else copy.parentId = parent
      if (!copy.rotation) delete copy.rotation
      const list = byParent.get(parent) ?? []
      list.push(copy.id)
      byParent.set(parent, list)
      fresh.set(copy.id, copy)
    } else copy.parentId = idMap.get(n.parentId!) ?? n.parentId
    const src = sourceOf.get(n.id)
    if (src === '') {
      delete copy.isComponent
      delete copy.description
      delete copy.flowStart
      copy.componentId = n.id
    } else if (src) {
      copy.sourceId = src
      delete copy.overrides
    }
    return copy
  })
  const ops: Op[] = []
  for (const [p, list] of byParent) ops.push(...arrange([...kids(st.doc, p), ...list], fresh))
  commit([...nodes.map((n) => ({ op: 'create' as const, node: n })), ...ops], { select: [...fresh.keys()] })
  return true
}

// ---------- creation ----------
export function insertNode(n: SceneNode, selectIt = true) {
  const st = S()
  n.order = nextOrder(st.doc, n.parentId ?? ROOT)
  commit([{ op: 'create', node: n }], selectIt ? { select: [n.id] } : {})
}

/** Parent frame + local coordinates for something created at a world point. */
export function placement(p: Pt): { parentId?: string; local: Pt; world: Mat } {
  const st = S()
  const parent = frameAt(st, p, new Set())
  const pm = worldOf(parent)
  const inv = invert(pm)
  return {
    parentId: parent === ROOT ? undefined : parent,
    local: { x: inv[0] * p.x + inv[2] * p.y + inv[4], y: inv[1] * p.x + inv[3] * p.y + inv[5] },
    world: pm,
  }
}

let uploader: (file: Blob) => Promise<string> = async () => {
  throw new Error('no uploader')
}
export function bindUploader(fn: (file: Blob) => Promise<string>) {
  uploader = fn
}

export const placeImageUrl = (file: Blob) => uploader(file)

export async function placeImage(file: Blob, at?: Pt, name = 'Image') {
  const bmp = await createImageBitmap(file)
  const url = await uploader(file)
  const st = S()
  const center = at ?? screenToWorld(st.canvasSize.w / 2, st.canvasSize.h / 2)
  const s = Math.min(1, 800 / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * s)
  const h = Math.round(bmp.height * s)
  const pl = placement(center)
  insertNode(
    makeNode('RECTANGLE', {
      name,
      parentId: pl.parentId,
      x: Math.round(pl.local.x - w / 2),
      y: Math.round(pl.local.y - h / 2),
      width: w,
      height: h,
      fills: [{ type: 'IMAGE', url, scaleMode: 'FILL' }],
    }),
  )
}

// ---------- viewport ----------
export function zoomAt(zoom: number, sx?: number, sy?: number) {
  const st = S()
  const z = Math.max(0.02, Math.min(256, zoom))
  const cx = sx ?? st.canvasSize.w / 2
  const cy = sy ?? st.canvasSize.h / 2
  const w = screenToWorld(cx, cy)
  patchState({ viewport: { zoom: z, x: cx - w.x * z, y: cy - w.y * z } })
}

export function zoomToBox(b: Box, maxZoom = 4) {
  const { canvasSize } = S()
  const pad = 80
  const z = Math.max(0.02, Math.min(maxZoom, (canvasSize.w - pad * 2) / (b.w || 1), (canvasSize.h - pad * 2) / (b.h || 1)))
  patchState({ viewport: { zoom: z, x: canvasSize.w / 2 - (b.x + b.w / 2) * z, y: canvasSize.h / 2 - (b.y + b.h / 2) * z } })
}

export function zoomToFit() {
  const st = S()
  const ids = kids(st.doc, ROOT)
  if (!ids.length) return patchState({ viewport: { zoom: 1, x: st.canvasSize.w / 2, y: st.canvasSize.h / 2 } })
  zoomToBox(unionBoxes(ids.map((id) => worldBoxOf(st, id))), 1)
}

export function zoomToNodes(ids: string[]) {
  const st = S()
  const list = ids.filter((id) => st.doc.byId.has(id))
  if (list.length) zoomToBox(unionBoxes(list.map((id) => worldBoxOf(st, id))))
}

// ---------- components ----------
/** Clones of main components become instances of them (duplicate, Alt-drag). Mutates `clones`. */
export function componentsToInstances(clones: SceneNode[], idMap: Map<string, string>, roots: string[]) {
  const { doc } = S()
  const byId = new Map(clones.map((c) => [c.id, c]))
  for (const r of roots) {
    const main = doc.byId.get(r)
    if (!main?.isComponent) continue
    const root = byId.get(idMap.get(r)!)!
    delete root.isComponent
    delete root.description
    delete root.flowStart
    root.componentId = r
    for (const d of descendants(doc, r)) {
      const c = byId.get(idMap.get(d)!)
      if (!c) continue
      c.sourceId = d
      delete c.overrides
    }
  }
}

export function createComponent() {
  const st = S()
  const sel = topLevelOnly(st.doc, st.selection)
  if (!sel.length) return
  const frames = sel.map((id) => node(id)!).filter((n) => n.type === 'FRAME' && !n.componentId && !n.sourceId && !n.isComponentSet)
  if (frames.length === sel.length) {
    const todo = frames.filter((n) => !n.isComponent)
    if (todo.length) commit(todo.map((n) => ({ op: 'update', id: n.id, patch: { isComponent: true } })))
    return
  }
  const count = [...st.doc.byId.values()].filter((n) => n.isComponent).length
  wrapSelection('FRAME', { isComponent: true, name: `Component ${count + 1}` })
}

export function combineAsVariants() {
  const st = S()
  const comps = sortByDocOrder(st.doc, topLevelOnly(st.doc, st.selection)).filter((id) => node(id)?.isComponent)
  if (!comps.length) return
  const names = comps.map((c) => node(c)!.name)
  const base = names[0].split('/')[0].replace(/=.*$/, '').trim() || 'Component'
  const id = wrapSelection('FRAME', {
    isComponentSet: true,
    name: base,
    layoutMode: 'VERTICAL',
    itemSpacing: 20,
    paddingLeft: 20,
    paddingRight: 20,
    paddingTop: 20,
    paddingBottom: 20,
    layoutSizingHorizontal: 'HUG',
    layoutSizingVertical: 'HUG',
    fills: [],
    clipsContent: false,
    strokes: [{ type: 'SOLID', color: '#9747FF' }],
    strokeWeight: 1,
    dashPattern: [6, 4],
    cornerRadius: 5,
  })
  if (!id) return
  const ops: Op[] = comps.map((c, i) => ({ op: 'update', id: c, patch: { name: names[i].includes('=') ? names[i] : `Variant=${i === 0 ? 'Default' : names[i]}` } }))
  commit(ops, { select: [id] })
}

/** Insert an instance of a component at a world point (or the middle of the viewport). */
export function createInstance(componentId: string, at?: Pt): string | null {
  const st = S()
  const main = st.doc.byId.get(componentId)
  if (!main) return null
  const { nodes, idMap } = cloneSubtrees(st.doc, [componentId])
  componentsToInstances(nodes, idMap, [componentId])
  const root = nodes.find((n) => n.id === idMap.get(componentId))!
  const center = at ?? screenToWorld(st.canvasSize.w / 2, st.canvasSize.h / 2)
  let pl = placement(center)
  const forbidden = new Set([componentId, ...descendants(st.doc, componentId)])
  let cur = pl.parentId
  while (cur) {
    if (forbidden.has(cur) || node(cur)?.isComponentSet) {
      pl = { parentId: undefined, local: center, world: IDM }
      break
    }
    cur = node(cur)?.parentId
  }
  if (pl.parentId) root.parentId = pl.parentId
  else delete root.parentId
  root.x = Math.round(pl.local.x - main.width / 2)
  root.y = Math.round(pl.local.y - main.height / 2)
  root.name = main.name.includes('=') && main.parentId ? (node(main.parentId)?.name ?? main.name) : main.name
  delete root.rotation
  delete root.layoutPositioning
  root.order = nextOrder(st.doc, pl.parentId ?? ROOT)
  commit(
    nodes.map((n) => ({ op: 'create' as const, node: n })),
    { select: [root.id] },
  )
  return root.id
}

const instanceRoots = () =>
  S()
    .selection.map((id) => node(id))
    .filter((n): n is SceneNode => !!n && !!n.componentId && !n.sourceId)

export function detachInstances() {
  const { doc } = S()
  const ops: Op[] = []
  for (const r of instanceRoots()) {
    ops.push({ op: 'update', id: r.id, patch: { componentId: null, overrides: null } })
    // Members become plain layers; members of nested instances re-link to that instance's own component.
    const walk = (id: string, nested: boolean) => {
      for (const c of kids(doc, id)) {
        const cn = node(c)!
        const src = cn.sourceId ? doc.byId.get(cn.sourceId) : undefined
        ops.push({ op: 'update', id: c, patch: { sourceId: nested && src?.sourceId ? src.sourceId : null, overrides: null } })
        walk(c, nested || !!cn.componentId)
      }
    }
    walk(r.id, false)
  }
  if (ops.length) commit(ops)
}

export function resetOverrides() {
  const { doc } = S()
  const ops: Op[] = []
  for (const r of instanceRoots())
    for (const id of [r.id, ...descendants(doc, r.id)]) if (node(id)!.overrides?.length) ops.push({ op: 'update', id, patch: { overrides: null } })
  if (ops.length) commit(ops)
}

export function swapInstance(id: string, componentId: string) {
  if (node(id)?.componentId === componentId) return
  commit([{ op: 'update', id, patch: { componentId, overrides: null } }])
}

export function goToMainComponent() {
  const st = S()
  let n = node(st.selection[0])
  let guard = 0
  while (n && !n.componentId && n.parentId && guard++ < 200) n = node(n.parentId)
  const target = n?.componentId
  if (!target || !st.doc.byId.has(target)) return
  patchState({ selection: [target] })
  zoomToNodes([target])
}

// ---------- boolean / flatten / mask ----------
const BOOL_NAME: Record<BooleanOp, string> = { UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude' }

export function booleanOperation(op: BooleanOp) {
  const st = S()
  const ids = sortByDocOrder(st.doc, topLevelOnly(st.doc, st.selection))
  if (!ids.length) return
  if (ids.length === 1 && node(ids[0])!.booleanOp) {
    const n = node(ids[0])!
    return update([n.id], { booleanOp: op, ...(Object.values(BOOL_NAME).includes(n.name) ? { name: BOOL_NAME[op] } : {}) })
  }
  const style = node(ids[0])!
  wrapSelection('GROUP', {
    booleanOp: op,
    name: BOOL_NAME[op],
    fills: style.type === 'LINE' || style.type === 'TEXT' || !style.fills ? [{ type: 'SOLID', color: '#D9D9D9' }] : style.fills,
    ...(style.strokes?.length ? { strokes: style.strokes, strokeWeight: style.strokeWeight ?? 1, strokeAlign: 'CENTER' as const } : {}),
  })
}

/** Merge the selected shapes into one editable vector. */
export function flattenSelection() {
  const st = S()
  const ids = sortByDocOrder(st.doc, topLevelOnly(st.doc, st.selection)).filter((id) => {
    const n = node(id)!
    return n.type !== 'TEXT' && n.type !== 'FRAME' && !n.sourceId
  })
  if (!ids.length) return
  const front = ids[ids.length - 1]
  const parent = parentOf(st.doc, front)
  const inv = invert(worldOf(parent))
  const subs: SubPath[] = []
  for (const id of ids) {
    const s = outlineSubs(st.doc, node(id)!)
    if (s) subs.push(...transformSubs(s, mul(inv, worldOf(id))))
  }
  if (!subs.length) return
  const b = subsBounds(subs)
  const w = Math.max(1, Math.round(b.w * 100) / 100)
  const h = Math.max(1, Math.round(b.h * 100) / 100)
  const style = ids.map((id) => node(id)!).find((n) => n.type !== 'GROUP' || n.booleanOp) ?? node(ids[0])!
  const vector = makeNode('VECTOR', {
    parentId: parent === ROOT ? undefined : parent,
    x: b.x,
    y: b.y,
    width: w,
    height: h,
    vectorPath: serializePath(transformSubs(subs, translate(-b.x, -b.y))),
    vectorWidth: w,
    vectorHeight: h,
    vectorFillRule: 'evenodd',
    fills: style.type === 'LINE' ? [] : (style.fills ?? []),
    strokes: style.strokes ?? [],
    strokeWeight: style.strokeWeight ?? 1,
    strokeAlign: 'CENTER',
    ...(style.effects ? { effects: style.effects } : {}),
    ...(style.opacity != null ? { opacity: style.opacity } : {}),
    name: ids.length === 1 ? node(ids[0])!.name : 'Vector',
  })
  const gone = new Set<string>()
  for (const id of ids) {
    gone.add(id)
    for (const d of descendants(st.doc, id)) gone.add(d)
  }
  const ordered = kids(st.doc, parent).flatMap((k) => (k === front ? [vector.id] : gone.has(k) ? [] : [k]))
  commit([{ op: 'create', node: vector }, ...[...gone].map((id) => ({ op: 'delete' as const, id })), ...arrange(ordered, new Map([[vector.id, vector]]))], { select: [vector.id] })
}

export function toggleMask() {
  const st = S()
  const ids = sortByDocOrder(st.doc, topLevelOnly(st.doc, st.selection))
  if (!ids.length) return
  if (ids.length === 1) return update(ids, (n) => ({ isMask: n.isMask ? undefined : true }))
  const bottom = ids[0]
  const group = wrapSelection('GROUP', { name: 'Mask group' })
  if (group) {
    update([bottom], { isMask: true })
    patchState({ selection: [group] })
  }
}

// ---------- text styling ----------
const RUN_KEYS = ['fontFamily', 'fontWeight', 'fontSize', 'italic', 'textDecoration', 'letterSpacing', 'fills'] as const
const isRunKey = (k: string) => (RUN_KEYS as readonly string[]).includes(k)

/** Character range a style change applies to (null = whole nodes). */
export function activeTextRange(): { id: string; a: number; b: number } | null {
  const st = S()
  if (!st.editingId || !st.textSel) return null
  const a = Math.min(st.textSel.start, st.textSel.end)
  const b = Math.max(st.textSel.start, st.textSel.end)
  const len = (node(st.editingId)?.characters ?? '').length
  if (a === b || (a === 0 && b >= len)) return null
  return { id: st.editingId, a, b }
}

/** Apply typography / fill changes to the selected character range, or to whole nodes when there is none. */
export function styleText(ids: string[], patch: Partial<SceneNode>, commitNow = true) {
  const range = activeTextRange()
  const keys = Object.keys(patch)
  const runKeys = keys.filter(isRunKey)
  const src = patch as unknown as Record<string, unknown>
  if (range && runKeys.length) {
    const n = node(range.id)!
    const runPatch: Record<string, unknown> = {}
    const rest: Record<string, unknown> = {}
    for (const k of keys) (isRunKey(k) ? runPatch : rest)[k] = src[k]
    const runs = styleRange(n, range.a, range.b, runPatch as TextRunStyle)
    preview([range.id], { ...(rest as Partial<SceneNode>), textRuns: runs.length ? runs : undefined })
  } else {
    preview(ids, (n) => {
      if (n.type !== 'TEXT' || !n.textRuns?.length || !runKeys.length) return patch
      // A node-wide change replaces the same property on every run.
      const runs = cleanRuns(n.textRuns, (n.characters ?? '').length)
        .map((r) => {
          const style = { ...r.style } as Record<string, unknown>
          for (const k of runKeys) delete style[k]
          return { ...r, style: style as TextRunStyle }
        })
        .filter((r) => Object.keys(r.style).length)
      return { ...patch, textRuns: runs.length ? runs : undefined }
    })
  }
  if (commitNow) commitDraft()
}

export function toggleTextStyle(kind: 'bold' | 'italic' | 'underline' | 'strike') {
  const st = S()
  const ids = st.editingId ? [st.editingId] : st.selection.filter((id) => node(id)?.type === 'TEXT')
  if (!ids.length) return
  const first = node(ids[0])!
  const range = activeTextRange()
  const run = range ? cleanRuns(first.textRuns, (first.characters ?? '').length).find((r) => r.start <= range.a && r.end > range.a) : undefined
  const cur = { ...first, ...(run?.style ?? {}) } as SceneNode
  if (kind === 'bold') styleText(ids, { fontWeight: (cur.fontWeight ?? 400) >= 600 ? 400 : 700 })
  else if (kind === 'italic') styleText(ids, { italic: !cur.italic })
  else if (kind === 'underline') styleText(ids, { textDecoration: cur.textDecoration === 'UNDERLINE' ? 'NONE' : 'UNDERLINE' })
  else styleText(ids, { textDecoration: cur.textDecoration === 'STRIKETHROUGH' ? 'NONE' : 'STRIKETHROUGH' })
}

// ---------- prototype ----------
export function topFrameOf(id: string): string {
  const list = ancestors(S().doc, id)
  return list.length ? list[list.length - 1] : id
}

export function addReaction(fromId: string, toId: string) {
  const n = node(fromId)
  if (!n || fromId === toId) return
  const r: Reaction = { trigger: 'ON_CLICK', action: 'NAVIGATE', destinationId: toId, transition: 'DISSOLVE', duration: 300, easing: 'EASE_OUT' }
  update([fromId], { reactions: [...(n.reactions ?? []).filter((x) => x.trigger !== 'ON_CLICK'), r] })
}

// ---------- copy as ----------
export async function copyAs(kind: 'svg' | 'css' | 'png'): Promise<boolean> {
  const { doc, selection } = S()
  const list = sortByDocOrder(doc, topLevelOnly(doc, selection))
  if (!list.length) return false
  try {
    if (kind === 'svg') await navigator.clipboard.writeText(exportSvg(doc, list, { measure: measureText }).svg)
    else if (kind === 'css') await navigator.clipboard.writeText(cssText(doc, node(list[0])!))
    else {
      const b = unionBoxes(list.map((id) => worldBoxOf(S(), id)))
      const canvas = renderToCanvas(doc, list, b, 2)
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      if (!blob) return false
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    }
    return true
  } catch {
    return false
  }
}

export function setOpacity(v: number) {
  const ids = S().selection
  if (ids.length) update(ids, { opacity: v })
}
