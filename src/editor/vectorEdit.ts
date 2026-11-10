// Helpers for editing the bezier points of VECTOR nodes.
import { rotate, apply } from '../../shared/geometry'
import type { SceneNode } from '../../shared/types'
import { parsePath, serializePath, subsBounds, transformSubs, type SubPath, type VPoint } from '../../shared/vector'

const cache = new WeakMap<SceneNode, SubPath[]>()

/** The node's path as anchors in node-local pixels (the vectorWidth/Height scale is baked in). */
export function editSubs(n: SceneNode): SubPath[] {
  let subs = cache.get(n)
  if (!subs) {
    const sx = n.width / (n.vectorWidth || n.width || 1)
    const sy = n.height / (n.vectorHeight || n.height || 1)
    subs = parsePath(n.vectorPath ?? '')
    if (sx !== 1 || sy !== 1) subs = transformSubs(subs, [sx, 0, 0, sy, 0, 0])
    cache.set(n, subs)
  }
  return subs
}

export const cloneSubs = (subs: SubPath[]): SubPath[] => subs.map((s) => ({ closed: s.closed, pts: s.pts.map((p) => ({ ...p })) }))

/** Flattened list of anchors with their location. */
export function flatPoints(subs: SubPath[]): { s: number; i: number; p: VPoint }[] {
  const out: { s: number; i: number; p: VPoint }[] = []
  subs.forEach((sub, s) => sub.pts.forEach((p, i) => out.push({ s, i, p })))
  return out
}

/** Draft patch while dragging: the path may temporarily extend past the node box. */
export function writeSubs(n: SceneNode, subs: SubPath[]): Partial<SceneNode> {
  return { vectorPath: serializePath(subs), vectorWidth: n.width, vectorHeight: n.height }
}

/** Final patch: the node box is refit around the path. */
export function rebound(n: SceneNode, subs: SubPath[]): Partial<SceneNode> {
  const b = subsBounds(subs)
  const moved = transformSubs(subs, [1, 0, 0, 1, -b.x, -b.y])
  const d = apply(rotate(n.rotation ?? 0), { x: b.x, y: b.y })
  const w = Math.max(1, Math.round(b.w * 100) / 100)
  const h = Math.max(1, Math.round(b.h * 100) / 100)
  return { x: n.x + d.x, y: n.y + d.y, width: w, height: h, vectorPath: serializePath(moved), vectorWidth: w, vectorHeight: h }
}

export const hasHandles = (p: VPoint) => p.ix !== p.x || p.iy !== p.y || p.ox !== p.x || p.oy !== p.y
