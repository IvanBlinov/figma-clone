import type { SceneNode } from './types'

/** 2D affine matrix [a, b, c, d, e, f] — same layout as canvas / SVG. */
export type Mat = [number, number, number, number, number, number]
export interface Pt {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
}

export const apply = (m: Mat, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y]
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}
export const rotateAround = (deg: number, c: Pt): Mat => mul(translate(c.x, c.y), mul(rotate(deg), translate(-c.x, -c.y)))
export const matRotation = (m: Mat) => (Math.atan2(m[1], m[0]) * 180) / Math.PI

export function localMatrix(n: Pick<SceneNode, 'x' | 'y' | 'rotation'>): Mat {
  if (!n.rotation) return [1, 0, 0, 1, n.x, n.y]
  const r = rotate(n.rotation)
  return [r[0], r[1], r[2], r[3], n.x, n.y]
}

/** Recover x / y / rotation from a local matrix (no scale or skew is ever stored). */
export function decompose(m: Mat): { x: number; y: number; rotation: number } {
  let rotation = Math.round(matRotation(m) * 100) / 100
  if (Object.is(rotation, -0)) rotation = 0
  return { x: m[4], y: m[5], rotation }
}

export function corners(m: Mat, w: number, h: number): Pt[] {
  return [apply(m, { x: 0, y: 0 }), apply(m, { x: w, y: 0 }), apply(m, { x: w, y: h }), apply(m, { x: 0, y: h })]
}

export function boundsOf(points: Pt[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function unionBoxes(boxes: Box[]): Box {
  return boundsOf(boxes.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]))
}

export const boxesIntersect = (a: Box, b: Box) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export const boxContains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
