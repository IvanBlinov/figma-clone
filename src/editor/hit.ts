import { ancestors, kids, parentOf, ROOT, type DocIndex } from '../../shared/doc'
import { apply, boundsOf, corners, invert, type Box, type Mat, type Pt } from '../../shared/geometry'
import { fillRuleOf, isBoolean, shapeOf } from '../../shared/boolean'
import { visiblePaints } from '../../shared/paths'
import type { SceneNode } from '../../shared/types'
import type { EditorState, Guide } from './store'

type HitState = Pick<EditorState, 'doc' | 'world' | 'viewport'>

const probe = document.createElement('canvas').getContext('2d')!

function hitSelf(ix: DocIndex, n: SceneNode, q: Pt, tol: number): boolean {
  if (n.isMask) return false
  const inside = q.x >= -tol && q.y >= -tol && q.x <= n.width + tol && q.y <= n.height + tol
  if (n.type === 'LINE') return q.x >= -tol && q.x <= n.width + tol && Math.abs(q.y) <= tol + (n.strokeWeight ?? 1) / 2
  if (!inside) return false
  const hasFill = visiblePaints(n.fills).length > 0
  const hasStroke = visiblePaints(n.strokes).length > 0 && (n.strokeWeight ?? 1) > 0
  const sw = (n.strokeWeight ?? 1) + tol * 2
  switch (n.type) {
    case 'GROUP':
      if (!n.booleanOp) return false
      break
    case 'FRAME':
    case 'TEXT':
      return true
    case 'RECTANGLE': {
      if (hasFill || !hasStroke) return true
      return q.x < sw || q.y < sw || q.x > n.width - sw || q.y > n.height - sw
    }
    case 'ELLIPSE': {
      const rx = n.width / 2 || 1
      const ry = n.height / 2 || 1
      const d = ((q.x - rx) / rx) ** 2 + ((q.y - ry) / ry) ** 2
      if (hasFill || !hasStroke) return d <= 1.05
      const inner = Math.max(0, 1 - sw / Math.min(rx, ry))
      return d <= 1.1 && d >= inner * inner
    }
  }
  const shape = shapeOf(ix, n)!
  const p = new Path2D()
  p.addPath(new Path2D(shape.d), new DOMMatrix([shape.sx, 0, 0, shape.sy, 0, 0]))
  if (hasFill && probe.isPointInPath(p, q.x, q.y, fillRuleOf(n))) return true
  probe.lineWidth = sw + 4 * tol
  if (probe.isPointInStroke(p, q.x, q.y)) return true
  return !hasFill && !hasStroke && !isBoolean(n)
}

/** Path of node ids from page level down to the deepest node under the point (empty when nothing is hit). */
export function hitPath(st: HitState, p: Pt, skip?: Set<string>, root: string = ROOT): string[] {
  const tol = 3 / st.viewport.zoom
  const walk = (parent: string): string[] | null => {
    const list = kids(st.doc, parent)
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i]
      const n = st.doc.byId.get(id)!
      if (n.visible === false || n.locked || skip?.has(id)) continue
      const q = apply(invert(st.world.get(id)!), p)
      const inside = q.x >= 0 && q.y >= 0 && q.x <= n.width && q.y <= n.height
      if (isBoolean(n)) {
        // Boolean groups behave like one shape; their operands are reachable by drilling in.
        if (!hitSelf(st.doc, n, q, tol)) continue
        const sub = walk(id)
        return sub ? [id, ...sub] : [id]
      }
      if (n.type === 'FRAME' || n.type === 'GROUP') {
        if (!(n.type === 'FRAME' && n.clipsContent !== false && !inside)) {
          const sub = walk(id)
          if (sub) return [id, ...sub]
        }
      }
      if (hitSelf(st.doc, n, q, tol)) return [id]
    }
    return null
  }
  return walk(root) ?? []
}

/**
 * Figma-style click resolution: top-level frames are transparent to clicks on their children, nested
 * containers select as a unit unless the current selection is already inside them, and `deep` picks the leaf.
 */
export function pick(st: HitState & Pick<EditorState, 'selection'>, p: Pt, deep = false): string | null {
  const path = hitPath(st, p)
  if (!path.length) return null
  if (deep) return path[path.length - 1]
  let i = 0
  const top = st.doc.byId.get(path[0])!
  if (top.type === 'FRAME' && path.length > 1) i = 1
  // Stay inside the container the user has already drilled into.
  const entered = new Set<string>()
  for (const id of st.selection) {
    if (!st.doc.byId.has(id)) continue
    for (const a of ancestors(st.doc, id)) entered.add(a)
  }
  for (let j = path.length - 2; j >= i; j--) {
    if (entered.has(path[j])) {
      i = j + 1
      break
    }
  }
  return path[Math.min(i, path.length - 1)]
}

/** Node one level deeper than the current selection along the hit path (double-click). */
export function pickDeeper(st: HitState & Pick<EditorState, 'selection'>, p: Pt): string | null {
  const path = hitPath(st, p)
  if (!path.length) return null
  const idx = path.findIndex((id) => st.selection.includes(id))
  if (idx === -1) return path[0]
  return path[Math.min(idx + 1, path.length - 1)]
}

/** Deepest frame under the point that can adopt children. */
const BLOCK = '#block'
export function frameAt(st: HitState, p: Pt, exclude: Set<string>): string {
  const r = frameAtInner(st, p, exclude)
  return r === BLOCK ? ROOT : r
}
function frameAtInner(st: HitState, p: Pt, exclude: Set<string>): string {
  const walk = (parent: string): string | null => {
    const list = kids(st.doc, parent)
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i]
      const n = st.doc.byId.get(id)!
      if (n.visible === false || n.locked || exclude.has(id) || (n.type !== 'FRAME' && n.type !== 'GROUP') || n.booleanOp || n.isComponentSet) continue
      const q = apply(invert(st.world.get(id)!), p)
      const inside = q.x >= 0 && q.y >= 0 && q.x <= n.width && q.y <= n.height
      // Instances own their structure: a drop over one lands in whatever contains it.
      if (n.componentId || n.sourceId) {
        if (inside) return BLOCK
        continue
      }
      if (n.type === 'GROUP') {
        if (!inside) continue
        const sub = walk(id)
        if (sub === BLOCK) return parent === ROOT ? BLOCK : parent
        if (sub) return sub
        continue
      }
      if (!inside) {
        if (n.clipsContent === false) {
          const sub = walk(id)
          if (sub && sub !== BLOCK) return sub
        }
        continue
      }
      const sub = walk(id)
      return sub === BLOCK ? id : (sub ?? id)
    }
    return null
  }
  return walk(ROOT) ?? ROOT
}

export function worldBoxOf(st: Pick<EditorState, 'doc' | 'world'>, id: string): Box {
  const n = st.doc.byId.get(id)!
  return boundsOf(corners(st.world.get(id)!, n.width, n.height))
}

export const parentWorld = (st: Pick<EditorState, 'doc' | 'world'>, id: string): Mat => {
  const p = parentOf(st.doc, id)
  return p === ROOT ? [1, 0, 0, 1, 0, 0] : st.world.get(p)!
}

/** Snap a moving world box against sibling edges/centers. Returns the correction and guide lines. */
export function snapBox(
  st: HitState,
  box: Box,
  parentId: string,
  exclude: Set<string>,
  axes: { x: boolean; y: boolean } = { x: true, y: true },
): { dx: number; dy: number; guides: Guide[] } {
  const thr = 5 / st.viewport.zoom
  const targets: Box[] = []
  if (parentId !== ROOT && st.doc.byId.has(parentId)) targets.push(worldBoxOf(st, parentId))
  for (const id of kids(st.doc, parentId).slice(-300)) {
    if (exclude.has(id) || st.doc.byId.get(id)!.visible === false) continue
    targets.push(worldBoxOf(st, id))
  }
  const mine = { x: [box.x, box.x + box.w / 2, box.x + box.w], y: [box.y, box.y + box.h / 2, box.y + box.h] }
  let bestX: { d: number; at: number; t: Box } | null = null
  let bestY: { d: number; at: number; t: Box } | null = null
  for (const t of targets) {
    const tx = [t.x, t.x + t.w / 2, t.x + t.w]
    const ty = [t.y, t.y + t.h / 2, t.y + t.h]
    for (const a of mine.x) for (const b of tx) if (Math.abs(b - a) < thr && (!bestX || Math.abs(b - a) < Math.abs(bestX.d))) bestX = { d: b - a, at: b, t }
    for (const a of mine.y) for (const b of ty) if (Math.abs(b - a) < thr && (!bestY || Math.abs(b - a) < Math.abs(bestY.d))) bestY = { d: b - a, at: b, t }
  }
  const guides: Guide[] = []
  const dx = axes.x && bestX ? bestX.d : 0
  const dy = axes.y && bestY ? bestY.d : 0
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
  if (axes.x && bestX)
    guides.push({
      x1: bestX.at,
      x2: bestX.at,
      y1: Math.min(moved.y, bestX.t.y),
      y2: Math.max(moved.y + moved.h, bestX.t.y + bestX.t.h),
    })
  if (axes.y && bestY)
    guides.push({
      y1: bestY.at,
      y2: bestY.at,
      x1: Math.min(moved.x, bestY.t.x),
      x2: Math.max(moved.x + moved.w, bestY.t.x + bestY.t.w),
    })
  return { dx, dy, guides }
}
