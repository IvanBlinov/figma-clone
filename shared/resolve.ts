// Turns user edits into a consistent document: instance sync, constraints, auto layout.
import { ancestors, applyOpsToList, buildIndex, descendants, kids, type DocIndex } from './doc'
import { runLayout } from './layout'
import type { MeasureFn } from './text'
import { isAutoLayout, newId, type Constraints, type Op, type SceneNode } from './types'

type Rec = Record<string, unknown>
const GEOM = ['x', 'y', 'width', 'height'] as const

// ---------- constraints ----------
export function constrainChild(
  c: { x: number; y: number; width: number; height: number },
  cons: Constraints | undefined,
  ow: number,
  oh: number,
  nw: number,
  nh: number,
) {
  const out = { x: c.x, y: c.y, width: c.width, height: c.height }
  const axis = (mode: string | undefined, pos: 'x' | 'y', size: 'width' | 'height', o: number, n: number) => {
    const d = n - o
    if (!d) return
    switch (mode) {
      case 'MAX':
        out[pos] += d
        break
      case 'CENTER':
        out[pos] += d / 2
        break
      case 'STRETCH':
        if (c[size] > 0) out[size] = Math.max(1, c[size] + d)
        break
      case 'SCALE':
        if (o > 0) {
          out[pos] = (c[pos] * n) / o
          if (c[size] > 0) out[size] = Math.max(1, (c[size] * n) / o)
        }
        break
    }
  }
  axis(cons?.horizontal, 'x', 'width', ow, nw)
  axis(cons?.vertical, 'y', 'height', oh, nh)
  return out
}

/**
 * When a plain (non auto-layout) frame changed size between `before` and `after`, reposition its children
 * according to their constraints. `explicit` lists geometry keys set directly by the user (left untouched).
 */
export function applyConstraints(before: SceneNode[], after: SceneNode[], explicit?: Map<string, Set<string>>): SceneNode[] {
  const b = new Map(before.map((n) => [n.id, n]))
  let ix: DocIndex | null = null
  const replaced = new Map<string, SceneNode>()
  const get = (id: string) => replaced.get(id) ?? ix!.byId.get(id)!
  const walk = (id: string) => {
    const f = get(id)
    const bf = b.get(id)
    const list = kids(ix!, id)
    if (f.type === 'FRAME' && !isAutoLayout(f) && bf && (Math.abs(bf.width - f.width) > 0.001 || Math.abs(bf.height - f.height) > 0.001)) {
      for (const cid of list) {
        const c = get(cid)
        const bc = b.get(cid)
        if (!bc || (bc.parentId ?? '') !== (c.parentId ?? '') || !c.constraints) continue
        const t = constrainChild(bc, c.constraints, bf.width, bf.height, f.width, f.height)
        const ex = explicit?.get(cid)
        let next: SceneNode | null = null
        for (const k of GEOM) {
          if (ex?.has(k) || Math.abs(t[k] - c[k]) < 0.001) continue
          if (c.type === 'TEXT' && (k === 'height' || (k === 'width' && (c.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT'))) continue
          ;(next ??= { ...c })[k] = t[k]
        }
        if (next) {
          if (next.type === 'TEXT' && next.width !== c.width) next.textAutoResize = next.textAutoResize === 'NONE' ? 'NONE' : 'HEIGHT'
          replaced.set(cid, next)
        }
      }
    }
    for (const cid of list) walk(cid)
  }
  // Cheap exit: nothing to do unless some frame was resized.
  if (!after.some((n) => n.type === 'FRAME' && b.has(n.id) && (b.get(n.id)!.width !== n.width || b.get(n.id)!.height !== n.height))) return after
  ix = buildIndex(after)
  for (const id of kids(ix, '')) walk(id)
  return replaced.size ? after.map((n) => replaced.get(n.id) ?? n) : after
}

// ---------- components ----------
/** Never copied from the component to its instances. */
const NEVER = new Set(['id', 'parentId', 'sourceId', 'overrides', 'isComponent', 'isComponentSet', 'description', 'flowStart', 'pluginData', 'sharedPluginData'])
/** Owned by the instance root itself (its placement in the document). */
const ROOT_OWN = new Set([
  'x',
  'y',
  'rotation',
  'order',
  'name',
  'visible',
  'locked',
  'constraints',
  'layoutPositioning',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'componentId',
  'reactions',
  'scrollBehavior',
  'type',
])
const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b))

/** Keys of an update that count as overrides when applied to a node living inside an instance. */
export function overrideKeys(n: SceneNode, patch: Rec): string[] {
  const root = !!n.componentId && !n.sourceId
  return Object.keys(patch).filter((k) => !NEVER.has(k) && k !== 'order' && k !== 'componentId' && !(root && ROOT_OWN.has(k)))
}

/** Record overrides for edits made to instance members. */
function trackOverrides(raw: SceneNode[], ops: Op[]): Op[] {
  let byId: Map<string, SceneNode> | null = null
  return ops.map((op) => {
    if (op.op !== 'update' || 'overrides' in op.patch) return op
    byId ??= new Map(raw.map((n) => [n.id, n]))
    const n = byId.get(op.id)
    if (!n || (!n.sourceId && !n.componentId)) return op
    if ('componentId' in op.patch || 'sourceId' in op.patch) return op // swap / detach
    const keys = overrideKeys(n, op.patch)
    if (!keys.length) return op
    const set = new Set([...(n.overrides ?? []), ...keys])
    if (set.size === (n.overrides ?? []).length) return op
    return { ...op, patch: { ...op.patch, overrides: [...set] } }
  })
}

/** Geometry that auto layout / text sizing / group fitting computes — sync must leave it alone. */
function layoutOwned(n: SceneNode, parentAL: boolean, k: (typeof GEOM)[number]): boolean {
  if (n.type === 'GROUP') return true
  const flow = parentAL && n.layoutPositioning !== 'ABSOLUTE'
  if (k === 'x' || k === 'y') return flow
  const sizing = k === 'width' ? n.layoutSizingHorizontal : n.layoutSizingVertical
  if (n.type === 'TEXT') {
    const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
    if (k === 'width' ? mode === 'WIDTH_AND_HEIGHT' : mode !== 'NONE') return true
  }
  return (flow && sizing === 'FILL') || (isAutoLayout(n) && sizing === 'HUG')
}

/** Deleting a layer inside an instance hides it instead (the structure belongs to the component). */
function guardInstanceDeletes(raw: SceneNode[], ops: Op[]): Op[] {
  const del = new Set<string>()
  for (const op of ops) if (op.op === 'delete') del.add(op.id)
  if (!del.size) return ops
  const byId = new Map(raw.map((n) => [n.id, n]))
  return ops.map((op) => {
    if (op.op !== 'delete') return op
    const n = byId.get(op.id)
    if (!n?.sourceId) return op
    let p: SceneNode | undefined = n
    let guard = 0
    while (p && p.sourceId && guard++ < 500) p = p.parentId ? byId.get(p.parentId) : undefined
    if (!p || !p.componentId || del.has(p.id) || !byId.has(p.componentId)) return op
    return { op: 'update', id: n.id, patch: { visible: false } }
  })
}

/** Make every instance mirror its main component (structure and non-overridden props). Returns the same array if nothing changed. */
export function syncInstances(nodes: SceneNode[]): SceneNode[] {
  if (!nodes.some((n) => n.componentId && !n.sourceId)) return nodes
  const ix = buildIndex(nodes)
  const result = new Map<string, SceneNode>()
  const removed = new Set<string>()
  const created: SceneNode[] = []
  let changed = false

  for (const inst of nodes) {
    if (!inst.componentId || inst.sourceId) continue
    const main = ix.byId.get(inst.componentId)
    if (!main || main.id === inst.id || ancestors(ix, inst.id).includes(main.id)) continue
    const members = new Map<string, SceneNode>()
    const all = descendants(ix, inst.id)
    for (const id of all) {
      const m = ix.byId.get(id)!
      if (m.sourceId && !members.has(m.sourceId)) members.set(m.sourceId, m)
    }
    const kept = new Set<string>()

    // Root: copy everything it does not own or override.
    const ov = new Set(inst.overrides ?? [])
    const root: Rec = { ...inst }
    const mainRec = main as unknown as Rec
    for (const k of new Set([...Object.keys(main), ...Object.keys(inst)])) {
      if (NEVER.has(k) || ROOT_OWN.has(k) || ov.has(k)) continue
      if (k in mainRec) root[k] = mainRec[k]
      else delete root[k]
    }
    const rootNode = root as unknown as SceneNode
    const instParentNode = inst.parentId ? ix.byId.get(inst.parentId) : undefined
    const rootFlow = !!instParentNode && isAutoLayout(instParentNode)
    for (const k of ['width', 'height'] as const) if (layoutOwned(rootNode, rootFlow, k)) rootNode[k] = inst[k]
    const put = (cur: SceneNode | undefined, next: SceneNode) => {
      if (!cur) {
        created.push(next)
        changed = true
        return
      }
      const a = cur as unknown as Rec
      const b = next as unknown as Rec
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const k of keys)
        if (!same(a[k], b[k])) {
          result.set(cur.id, next)
          changed = true
          return
        }
    }
    put(inst, rootNode)

    const walk = (srcParent: SceneNode, instParent: SceneNode) => {
      const adapt = !isAutoLayout(instParent) && (srcParent.width !== instParent.width || srcParent.height !== instParent.height)
      for (const sid of kids(ix, srcParent.id)) {
        const src = ix.byId.get(sid)!
        const cur = members.get(sid)
        const o = new Set(cur?.overrides ?? [])
        const next: Rec = { id: cur?.id ?? newId(), sourceId: sid }
        if (cur?.overrides?.length) next.overrides = cur.overrides
        const curRec = (cur ?? {}) as unknown as Rec
        for (const [k, v] of Object.entries(src)) {
          if (NEVER.has(k)) continue
          next[k] = o.has(k) && cur && k in curRec ? curRec[k] : v
        }
        for (const k of o) if (!(k in next) && k in curRec && !NEVER.has(k)) next[k] = curRec[k]
        for (const k of o) if (!(k in curRec) && cur) delete next[k]
        next.parentId = instParent.id
        const node = next as unknown as SceneNode
        const parentAL = isAutoLayout(instParent)
        const t = adapt ? constrainChild(src, src.constraints, srcParent.width, srcParent.height, instParent.width, instParent.height) : null
        for (const k of GEOM) {
          if (o.has(k)) continue
          if (cur && layoutOwned(node, parentAL, k)) node[k] = cur[k]
          else if (t) node[k] = t[k]
        }
        if (cur) kept.add(cur.id)
        put(cur, node)
        walk(src, node)
      }
    }
    walk(main, rootNode)
    for (const id of all)
      if (!kept.has(id)) {
        removed.add(id)
        changed = true
      }
  }
  if (!changed) return nodes
  const out: SceneNode[] = []
  for (const n of nodes) {
    if (removed.has(n.id)) continue
    out.push(result.get(n.id) ?? n)
  }
  return [...out, ...created]
}

// ---------- pipeline ----------
export function diffOps(before: SceneNode[], after: SceneNode[]): Op[] {
  const b = new Map(before.map((n) => [n.id, n]))
  const ops: Op[] = []
  const seen = new Set<string>()
  for (const n of after) {
    seen.add(n.id)
    const old = b.get(n.id)
    if (!old) {
      ops.push({ op: 'create', node: n })
      continue
    }
    if (old === n) continue
    const a = old as unknown as Rec
    const c = n as unknown as Rec
    let patch: Rec | null = null
    for (const k of Object.keys(c)) {
      const v = c[k]
      const o = a[k]
      if (v === o) continue
      if (typeof v === 'number' && typeof o === 'number' ? Math.abs(v - o) > 0.005 : !same(v, o)) (patch ??= {})[k] = v
    }
    for (const k of Object.keys(a)) if (!(k in c)) (patch ??= {})[k] = null
    if (patch) ops.push({ op: 'update', id: n.id, patch })
  }
  for (const n of before) if (!seen.has(n.id)) ops.push({ op: 'delete', id: n.id })
  return ops
}

function explicitGeometry(ops: Op[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const op of ops) {
    if (op.op !== 'update') continue
    for (const k of GEOM)
      if (k in op.patch) {
        let s = out.get(op.id)
        if (!s) out.set(op.id, (s = new Set()))
        s.add(k)
      }
  }
  return out
}

/** Derived state for a document: instances synced, constraints applied (relative to `before`), layout run. */
export function settle(before: SceneNode[], nodes: SceneNode[], measure: MeasureFn, explicit?: Map<string, Set<string>>): SceneNode[] {
  let cur = nodes
  for (let pass = 0; pass < 5; pass++) {
    const synced = syncInstances(cur)
    const constrained = applyConstraints(before, synced, explicit)
    const laid = runLayout(constrained, measure)
    const stable = synced === cur && constrained === synced && !laid.patches.length
    cur = laid.patches.length ? laid.nodes : constrained
    if (stable) break
  }
  return cur
}

/**
 * Expand user ops into the full set of ops to store: the edits themselves plus everything they imply
 * (override bookkeeping, instance updates, constraint-driven moves, auto-layout results).
 */
export function resolveOps(raw: SceneNode[], userOps: Op[], measure: MeasureFn): { ops: Op[]; nodes: SceneNode[] } {
  const ops = trackOverrides(raw, guardInstanceDeletes(raw, userOps))
  const base = applyOpsToList(raw, ops)
  const nodes = settle(raw, base, measure, explicitGeometry(userOps))
  return { ops: [...ops, ...diffOps(base, nodes)], nodes }
}
