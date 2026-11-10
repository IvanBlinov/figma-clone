// Boolean groups (union / subtract / intersect / exclude) and node outlines as editable paths.
import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping'
import { descendants, kids, type DocIndex } from './doc'
import { localMatrix, type Mat } from './geometry'
import { nodeShape, type NodeShape } from './paths'
import type { SceneNode } from './types'
import { flattenSub, parsePath, transformSubs, type SubPath } from './vector'

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** Outline of a node as bezier subpaths in its own coordinate space (null for text). */
export function outlineSubs(ix: DocIndex, n: SceneNode): SubPath[] | null {
  if (n.type === 'TEXT') return null
  if (n.type === 'GROUP' && n.booleanOp) return parsePath(booleanPath(ix, n))
  if (n.type === 'GROUP') {
    const out: SubPath[] = []
    for (const c of kids(ix, n.id)) {
      const cn = ix.byId.get(c)!
      if (cn.visible === false) continue
      const s = outlineSubs(ix, cn)
      if (s) out.push(...transformSubs(s, localMatrix(cn)))
    }
    return out
  }
  const shape = nodeShape(n)
  if (!shape) return null
  const subs = parsePath(shape.d)
  return shape.sx === 1 && shape.sy === 1 ? subs : transformSubs(subs, [shape.sx, 0, 0, shape.sy, 0, 0])
}

function toGeom(subs: SubPath[]): MultiPolygon {
  let geom: MultiPolygon = []
  for (const s of subs) {
    if (!s.closed || s.pts.length < 2) continue
    const ring: Ring = flattenSub(s).map((p) => [r3(p.x), r3(p.y)] as [number, number])
    if (ring.length < 3) continue
    ring.push(ring[0])
    try {
      // Sub-paths of one shape combine with even-odd semantics (holes).
      geom = geom.length ? polygonClipping.xor(geom, [[ring]]) : polygonClipping.union([[ring]])
    } catch {
      /* degenerate ring: ignore */
    }
  }
  return geom
}

function geomOf(ix: DocIndex, n: SceneNode, m: Mat): MultiPolygon {
  if (n.type === 'GROUP' && n.booleanOp) {
    const g = booleanGeom(ix, n)
    return g.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r3(m[0] * x + m[2] * y + m[4]), r3(m[1] * x + m[3] * y + m[5])] as [number, number])))
  }
  const subs = outlineSubs(ix, n)
  return subs ? toGeom(transformSubs(subs, m)) : []
}

function booleanGeom(ix: DocIndex, n: SceneNode): MultiPolygon {
  const geoms: MultiPolygon[] = []
  for (const c of kids(ix, n.id)) {
    const cn = ix.byId.get(c)!
    if (cn.visible === false) continue
    const g = geomOf(ix, cn, localMatrix(cn))
    if (g.length || geoms.length === 0) geoms.push(g)
  }
  if (!geoms.length) return []
  const [first, ...rest] = geoms
  try {
    if (!rest.length) return first
    switch (n.booleanOp) {
      case 'SUBTRACT':
        return polygonClipping.difference(first, ...rest)
      case 'INTERSECT':
        return polygonClipping.intersection(first, ...rest)
      case 'EXCLUDE':
        return polygonClipping.xor(first, ...rest)
      default:
        return polygonClipping.union(first, ...rest)
    }
  } catch {
    return geoms.flat()
  }
}

const cache = new Map<string, { sig: string; d: string }>()

/** SVG path of a boolean group in its local coordinate space. Cached until any descendant geometry changes. */
export function booleanPath(ix: DocIndex, n: SceneNode): string {
  const parts: unknown[] = [n.booleanOp]
  for (const id of descendants(ix, n.id)) {
    const c = ix.byId.get(id)!
    parts.push([c.id, c.parentId, c.order, c.type, c.x, c.y, c.width, c.height, c.rotation, c.visible, c.cornerRadius, c.cornerRadii, c.pointCount, c.starInnerRadius, c.vectorPath, c.vectorWidth, c.vectorHeight, c.booleanOp])
  }
  const sig = JSON.stringify(parts)
  const hit = cache.get(n.id)
  if (hit && hit.sig === sig) return hit.d
  let d = ''
  for (const poly of booleanGeom(ix, n))
    for (const ring of poly) {
      ring.forEach(([x, y], i) => {
        if (i === ring.length - 1) return
        d += `${i ? 'L' : 'M'}${x} ${y}`
      })
      d += 'Z'
    }
  if (cache.size > 2000) cache.clear()
  cache.set(n.id, { sig, d })
  return d
}

export const isBoolean = (n: SceneNode) => n.type === 'GROUP' && !!n.booleanOp
/** Plain groups have no outline of their own; everything else (including boolean groups) paints. */
export const paintsSelf = (n: SceneNode) => n.type !== 'GROUP' || !!n.booleanOp

/** Like `nodeShape`, but aware of boolean groups. */
export function shapeOf(ix: DocIndex, n: SceneNode, inset = 0): NodeShape | null {
  if (isBoolean(n)) return { d: booleanPath(ix, n), sx: 1, sy: 1, offsettable: false }
  return nodeShape(n, inset)
}

export const fillRuleOf = (n: SceneNode): 'nonzero' | 'evenodd' => (isBoolean(n) || (n.type === 'VECTOR' && n.vectorFillRule === 'evenodd') ? 'evenodd' : 'nonzero')
