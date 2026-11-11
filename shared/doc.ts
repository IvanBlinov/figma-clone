import { IDENTITY, localMatrix, mul, corners, boundsOf, type Mat, type Box } from './geometry'
import { newId, typeLabel, type NodeType, type Op, type SceneNode } from './types'

export const ROOT = ''

export interface DocIndex {
  byId: Map<string, SceneNode>
  /** parent id (ROOT for page-level) → child ids sorted back → front */
  children: Map<string, string[]>
}

export function buildIndex(nodes: SceneNode[]): DocIndex {
  const byId = new Map<string, SceneNode>()
  for (const n of nodes) byId.set(n.id, n)
  const children = new Map<string, string[]>()
  for (const n of nodes) {
    // Orphans (parent missing) are shown at page level rather than lost.
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : ROOT
    let list = children.get(p)
    if (!list) children.set(p, (list = []))
    list.push(n.id)
  }
  for (const list of children.values())
    list.sort((a, b) => {
      const d = byId.get(a)!.order - byId.get(b)!.order
      return d || (a < b ? -1 : 1)
    })
  return { byId, children }
}

export const kids = (ix: DocIndex, id: string): string[] => ix.children.get(id) ?? []
export const parentOf = (ix: DocIndex, id: string): string => {
  const p = ix.byId.get(id)?.parentId
  return p && ix.byId.has(p) ? p : ROOT
}

export function descendants(ix: DocIndex, id: string): string[] {
  const out: string[] = []
  const walk = (i: string) => {
    for (const c of kids(ix, i)) {
      out.push(c)
      walk(c)
    }
  }
  walk(id)
  return out
}

/** Prototype screens: the page's top-level frames, looking through sections (which only organise them). */
export function screenFrames(ix: DocIndex, parent: string = ROOT): string[] {
  const out: string[] = []
  for (const id of kids(ix, parent)) {
    const n = ix.byId.get(id)!
    if (n.type !== 'FRAME') continue
    if (n.isSection) out.push(...screenFrames(ix, id))
    else out.push(id)
  }
  return out
}

export function ancestors(ix: DocIndex, id: string): string[] {
  const out: string[] = []
  let p = parentOf(ix, id)
  let guard = 0
  while (p !== ROOT && guard++ < 1000) {
    out.push(p)
    p = parentOf(ix, p)
  }
  return out
}

/** Drop ids whose ancestor is also in the list. */
export function topLevelOnly(ix: DocIndex, ids: string[]): string[] {
  const set = new Set(ids)
  return ids.filter((id) => ix.byId.has(id) && !ancestors(ix, id).some((a) => set.has(a)))
}

/** Sort ids in document (paint) order. */
export function sortByDocOrder(ix: DocIndex, ids: string[]): string[] {
  const pos = new Map<string, number>()
  let i = 0
  const walk = (p: string) => {
    for (const c of kids(ix, p)) {
      pos.set(c, i++)
      walk(c)
    }
  }
  walk(ROOT)
  return [...ids].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0))
}

export function applyOpsToList(nodes: SceneNode[], ops: Op[]): SceneNode[] {
  const map = new Map(nodes.map((n) => [n.id, n]))
  for (const op of ops) {
    if (op.op === 'create') map.set(op.node.id, op.node)
    else if (op.op === 'delete') map.delete(op.id)
    else {
      const cur = map.get(op.id)
      if (!cur) continue
      const next: Record<string, unknown> = { ...cur }
      for (const [k, v] of Object.entries(op.patch)) {
        if (k === 'id') continue
        if (v === null || v === undefined) delete next[k]
        else next[k] = v
      }
      map.set(op.id, next as unknown as SceneNode)
    }
  }
  return [...map.values()]
}

export function worldMatrix(ix: DocIndex, id: string): Mat {
  const n = ix.byId.get(id)
  if (!n) return IDENTITY
  const p = parentOf(ix, id)
  const local = localMatrix(n)
  return p === ROOT ? local : mul(worldMatrix(ix, p), local)
}

export function computeWorld(ix: DocIndex): Map<string, Mat> {
  const out = new Map<string, Mat>()
  const walk = (p: string, pm: Mat) => {
    for (const c of kids(ix, p)) {
      const m = mul(pm, localMatrix(ix.byId.get(c)!))
      out.set(c, m)
      walk(c, m)
    }
  }
  walk(ROOT, IDENTITY)
  return out
}

export function worldBox(ix: DocIndex, id: string, world?: Map<string, Mat>): Box {
  const n = ix.byId.get(id)!
  const m = world?.get(id) ?? worldMatrix(ix, id)
  return boundsOf(corners(m, n.width, n.height))
}

export function nextOrder(ix: DocIndex, parentId: string): number {
  const list = kids(ix, parentId)
  return list.length ? ix.byId.get(list[list.length - 1])!.order + 1 : 0
}

/** Ops that renumber the children of a parent to match `ordered`. */
export function reorderOps(ix: DocIndex, ordered: string[]): Op[] {
  const ops: Op[] = []
  ordered.forEach((id, i) => {
    if (ix.byId.get(id)?.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
  })
  return ops
}

/** Deep-copy subtrees with fresh ids. Returned nodes keep their original parentId for the roots. */
export function cloneSubtrees(ix: DocIndex, ids: string[]): { nodes: SceneNode[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  const all: string[] = []
  for (const id of topLevelOnly(ix, ids)) all.push(id, ...descendants(ix, id))
  for (const id of all) idMap.set(id, newId())
  const nodes = all.map((id) => {
    const n = ix.byId.get(id)!
    return { ...n, id: idMap.get(id)!, parentId: n.parentId && idMap.has(n.parentId) ? idMap.get(n.parentId) : n.parentId }
  })
  return { nodes, idMap }
}

export function uniqueName(ix: DocIndex, type: NodeType): string {
  const label = typeLabel(type)
  if (type === 'TEXT') return 'Text'
  let max = 0
  for (const n of ix.byId.values()) {
    if (n.type !== type) continue
    const m = n.name.match(new RegExp(`^${label} (\\d+)$`))
    if (m) max = Math.max(max, +m[1])
  }
  return `${label} ${max + 1}`
}

export function cssColor(hex: string, opacity = 1): string {
  let h = (hex || '#000000').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  const a = h.length >= 8 ? (parseInt(h.slice(6, 8), 16) / 255) * opacity : opacity
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.round(a * 1000) / 1000})`
}
