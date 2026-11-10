// SVG path data ⇄ editable bezier points, plus flattening for boolean operations.
import { apply, type Box, type Mat, type Pt } from './geometry'

/** Anchor with absolute in/out handle positions (equal to the anchor when the side is straight). */
export interface VPoint {
  x: number
  y: number
  ix: number
  iy: number
  ox: number
  oy: number
}
export interface SubPath {
  pts: VPoint[]
  closed: boolean
}

const EPS = 1e-6
const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: boolean, fs: boolean, x2: number, y2: number): number[][] {
  if (near(x1, y1, x2, y2)) return []
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coef = den ? Math.sqrt(Math.max(0, num / den)) : 0
  if (fa === fs) coef = -coef
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const th1 = ang(1, 0, ux, uy)
  let dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dth > 0) dth -= 2 * Math.PI
  else if (fs && dth < 0) dth += 2 * Math.PI
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9))
  const delta = dth / segs
  const t = (4 / 3) * Math.tan(delta / 4)
  const map = (u: number, v: number): [number, number] => [cx + cosP * rx * u - sinP * ry * v, cy + sinP * rx * u + cosP * ry * v]
  const out: number[][] = []
  for (let i = 0; i < segs; i++) {
    const a1 = th1 + i * delta
    const a2 = a1 + delta
    const c1 = map(Math.cos(a1) - t * Math.sin(a1), Math.sin(a1) + t * Math.cos(a1))
    const c2 = map(Math.cos(a2) + t * Math.sin(a2), Math.sin(a2) - t * Math.cos(a2))
    const p = i === segs - 1 ? [x2, y2] : map(Math.cos(a2), Math.sin(a2))
    out.push([c1[0], c1[1], c2[0], c2[1], p[0], p[1]])
  }
  return out
}

/** Parse SVG path data into subpaths of cubic bezier anchors. All commands (incl. arcs, quadratics, relative) are supported. */
export function parsePath(d: string): SubPath[] {
  const subs: SubPath[] = []
  let sub: SubPath | null = null
  let i = 0
  const n = d.length
  const skip = () => {
    while (i < n && (d[i] === ' ' || d[i] === ',' || d[i] === '\n' || d[i] === '\t' || d[i] === '\r')) i++
  }
  const num = (): number => {
    skip()
    const s = i
    if (d[i] === '-' || d[i] === '+') i++
    while (i < n && d[i] >= '0' && d[i] <= '9') i++
    if (d[i] === '.') {
      i++
      while (i < n && d[i] >= '0' && d[i] <= '9') i++
    }
    if ((d[i] === 'e' || d[i] === 'E') && i > s) {
      i++
      if (d[i] === '-' || d[i] === '+') i++
      while (i < n && d[i] >= '0' && d[i] <= '9') i++
    }
    if (i === s) {
      i = n // malformed: stop
      return 0
    }
    return parseFloat(d.slice(s, i))
  }
  const flag = (): boolean => {
    skip()
    return d[i++] === '1'
  }
  const more = () => {
    skip()
    return i < n && !/[a-zA-Z]/.test(d[i])
  }
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let lcx = 0 // last control point (for S / T)
  let lcy = 0
  let lastCmd = ''
  const begin = (x: number, y: number) => {
    sub = { pts: [{ x, y, ix: x, iy: y, ox: x, oy: y }], closed: false }
    subs.push(sub)
    sx = x
    sy = y
  }
  const seg = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
    if (!sub || sub.closed) begin(cx, cy)
    const last = sub!.pts[sub!.pts.length - 1]
    last.ox = c1x
    last.oy = c1y
    sub!.pts.push({ x, y, ix: c2x, iy: c2y, ox: x, oy: y })
    cx = x
    cy = y
  }
  while (i < n) {
    skip()
    if (i >= n) break
    const c = d[i]
    if (!/[a-zA-Z]/.test(c)) break
    i++
    const rel = c === c.toLowerCase()
    const C = c.toUpperCase()
    if (C === 'Z') {
      if (sub && !(sub as SubPath).closed) {
        const s = sub as SubPath
        s.closed = true
        const first = s.pts[0]
        const last = s.pts[s.pts.length - 1]
        if (s.pts.length > 1 && near(first.x, first.y, last.x, last.y)) {
          first.ix = last.ix
          first.iy = last.iy
          s.pts.pop()
        }
      }
      cx = sx
      cy = sy
      lastCmd = 'Z'
      continue
    }
    let first = true
    do {
      const bx = rel ? cx : 0
      const by = rel ? cy : 0
      switch (C) {
        case 'M': {
          const x = num() + bx
          const y = num() + by
          if (first) {
            begin(x, y)
            cx = x
            cy = y
          } else seg(cx, cy, x, y, x, y)
          break
        }
        case 'L': {
          const x = num() + bx
          const y = num() + by
          seg(cx, cy, x, y, x, y)
          break
        }
        case 'H': {
          const x = num() + bx
          seg(cx, cy, x, cy, x, cy)
          break
        }
        case 'V': {
          const y = num() + by
          seg(cx, cy, cx, y, cx, y)
          break
        }
        case 'C': {
          const a = num() + bx
          const b = num() + by
          const e = num() + bx
          const f = num() + by
          const x = num() + bx
          const y = num() + by
          seg(a, b, e, f, x, y)
          lcx = e
          lcy = f
          break
        }
        case 'S': {
          const prevC = lastCmd === 'C' || lastCmd === 'S'
          const a = prevC ? 2 * cx - lcx : cx
          const b = prevC ? 2 * cy - lcy : cy
          const e = num() + bx
          const f = num() + by
          const x = num() + bx
          const y = num() + by
          seg(a, b, e, f, x, y)
          lcx = e
          lcy = f
          break
        }
        case 'Q':
        case 'T': {
          let qx: number
          let qy: number
          if (C === 'Q') {
            qx = num() + bx
            qy = num() + by
          } else {
            const prevQ = lastCmd === 'Q' || lastCmd === 'T'
            qx = prevQ ? 2 * cx - lcx : cx
            qy = prevQ ? 2 * cy - lcy : cy
          }
          const x = num() + bx
          const y = num() + by
          seg(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y)
          lcx = qx
          lcy = qy
          break
        }
        case 'A': {
          const rx = num()
          const ry = num()
          const rot = num()
          const fa = flag()
          const fs = flag()
          const x = num() + bx
          const y = num() + by
          const cubics = arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y)
          for (const q of cubics) seg(q[0], q[1], q[2], q[3], q[4], q[5])
          break
        }
        default:
          i = n
      }
      lastCmd = C
      first = false
    } while (more())
  }
  return subs.filter((s) => s.pts.length > 0)
}

const straight = (a: VPoint, b: VPoint) => near(a.ox, a.oy, a.x, a.y) && near(b.ix, b.iy, b.x, b.y)

export function serializePath(subs: SubPath[], precision = 2): string {
  const k = 10 ** precision
  const f = (v: number) => (Math.round(v * k) / k).toString()
  let d = ''
  for (const s of subs) {
    if (!s.pts.length) continue
    d += `M${f(s.pts[0].x)} ${f(s.pts[0].y)}`
    const count = s.pts.length + (s.closed ? 1 : 0)
    for (let i = 1; i < count; i++) {
      const a = s.pts[i - 1]
      const b = s.pts[i % s.pts.length]
      if (straight(a, b)) {
        if (i < s.pts.length) d += `L${f(b.x)} ${f(b.y)}`
      } else d += `C${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`
    }
    if (s.closed) d += 'Z'
  }
  return d
}

export function transformSubs(subs: SubPath[], m: Mat): SubPath[] {
  return subs.map((s) => ({
    closed: s.closed,
    pts: s.pts.map((p) => {
      const a = apply(m, p)
      const i = apply(m, { x: p.ix, y: p.iy })
      const o = apply(m, { x: p.ox, y: p.oy })
      return { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y }
    }),
  }))
}

export const cubicAt = (a: VPoint, b: VPoint, t: number): Pt => {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * a.ox + 3 * u * t * t * b.ix + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * a.oy + 3 * u * t * t * b.iy + t * t * t * b.y,
  }
}

/** Segments of a subpath as [from, to] anchor index pairs. */
export function segmentsOf(s: SubPath): [number, number][] {
  const out: [number, number][] = []
  for (let i = 1; i < s.pts.length; i++) out.push([i - 1, i])
  if (s.closed && s.pts.length > 1) out.push([s.pts.length - 1, 0])
  return out
}

/** Polyline approximation of a subpath. */
export function flattenSub(s: SubPath, step = 1.5): Pt[] {
  const out: Pt[] = [{ x: s.pts[0].x, y: s.pts[0].y }]
  for (const [ai, bi] of segmentsOf(s)) {
    const a = s.pts[ai]
    const b = s.pts[bi]
    if (straight(a, b)) {
      out.push({ x: b.x, y: b.y })
      continue
    }
    const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy)
    const nseg = Math.max(8, Math.min(96, Math.ceil(len / step)))
    for (let k = 1; k <= nseg; k++) out.push(cubicAt(a, b, k / nseg))
  }
  return out
}

export function subsBounds(subs: SubPath[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of subs)
    for (const p of flattenSub(s, 4)) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Split the segment a→b at t, returning the new anchor and the adjusted neighbouring handles. */
export function splitSegment(a: VPoint, b: VPoint, t: number): { a: VPoint; mid: VPoint; b: VPoint } {
  const lerp = (p: Pt, q: Pt): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const p0 = { x: a.x, y: a.y }
  const p1 = { x: a.ox, y: a.oy }
  const p2 = { x: b.ix, y: b.iy }
  const p3 = { x: b.x, y: b.y }
  const q0 = lerp(p0, p1)
  const q1 = lerp(p1, p2)
  const q2 = lerp(p2, p3)
  const r0 = lerp(q0, q1)
  const r1 = lerp(q1, q2)
  const m = lerp(r0, r1)
  const wasStraight = straight(a, b)
  return {
    a: { ...a, ox: wasStraight ? a.x : q0.x, oy: wasStraight ? a.y : q0.y },
    mid: wasStraight ? { x: m.x, y: m.y, ix: m.x, iy: m.y, ox: m.x, oy: m.y } : { x: m.x, y: m.y, ix: r0.x, iy: r0.y, ox: r1.x, oy: r1.y },
    b: { ...b, ix: wasStraight ? b.x : q2.x, iy: wasStraight ? b.y : q2.y },
  }
}

/** Fit a smooth path through freehand points (Ramer–Douglas–Peucker + Catmull-Rom tangents). */
export function smoothPath(points: Pt[], tolerance: number): SubPath {
  const keep = new Array(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const rdp = (a: number, b: number) => {
    let max = 0
    let idx = -1
    const pa = points[a]
    const pb = points[b]
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs((pb.x - pa.x) * (pa.y - points[i].y) - (pa.x - points[i].x) * (pb.y - pa.y)) / len
      if (dist > max) {
        max = dist
        idx = i
      }
    }
    if (max > tolerance && idx > 0) {
      keep[idx] = true
      rdp(a, idx)
      rdp(idx, b)
    }
  }
  if (points.length > 2) rdp(0, points.length - 1)
  const pts = points.filter((_, i) => keep[i])
  return {
    closed: false,
    pts: pts.map((p, i) => {
      const prev = pts[i - 1]
      const next = pts[i + 1]
      if (!prev || !next) return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y }
      const tx = (next.x - prev.x) / 6
      const ty = (next.y - prev.y) / 6
      return { x: p.x, y: p.y, ix: p.x - tx, iy: p.y - ty, ox: p.x + tx, oy: p.y + ty }
    }),
  }
}
