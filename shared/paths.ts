import type { Paint, SceneNode } from './types'

const f = (v: number) => (Math.round(v * 1000) / 1000).toString()

export function radiiOf(n: SceneNode): [number, number, number, number] {
  if (n.type !== 'RECTANGLE' && n.type !== 'FRAME') return [0, 0, 0, 0]
  const r = n.cornerRadii ?? [n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0]
  return r
}

export function roundRectPath(x: number, y: number, w: number, h: number, radii: number[]): string {
  const max = Math.min(w, h) / 2
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, max)))
  if (!tl && !tr && !br && !bl) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`
  return (
    `M${f(x + tl)} ${f(y)}H${f(x + w - tr)}` +
    (tr ? `A${f(tr)} ${f(tr)} 0 0 1 ${f(x + w)} ${f(y + tr)}` : '') +
    `V${f(y + h - br)}` +
    (br ? `A${f(br)} ${f(br)} 0 0 1 ${f(x + w - br)} ${f(y + h)}` : '') +
    `H${f(x + bl)}` +
    (bl ? `A${f(bl)} ${f(bl)} 0 0 1 ${f(x)} ${f(y + h - bl)}` : '') +
    `V${f(y + tl)}` +
    (tl ? `A${f(tl)} ${f(tl)} 0 0 1 ${f(x + tl)} ${f(y)}` : '') +
    'Z'
  )
}

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2
  const ry = h / 2
  return `M${f(x)} ${f(y + ry)}A${f(rx)} ${f(ry)} 0 1 1 ${f(x + w)} ${f(y + ry)}A${f(rx)} ${f(ry)} 0 1 1 ${f(x)} ${f(y + ry)}Z`
}

function polyPath(n: SceneNode): string {
  const count = Math.max(3, Math.round(n.pointCount ?? (n.type === 'STAR' ? 5 : 3)))
  const star = n.type === 'STAR'
  const total = star ? count * 2 : count
  const inner = n.starInnerRadius ?? 0.382
  let d = ''
  for (let i = 0; i < total; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / total
    const r = star && i % 2 === 1 ? inner : 1
    const px = n.width / 2 + (n.width / 2) * r * Math.cos(a)
    const py = n.height / 2 + (n.height / 2) * r * Math.sin(a)
    d += `${i ? 'L' : 'M'}${f(px)} ${f(py)}`
  }
  return d + 'Z'
}

export interface NodeShape {
  d: string
  /** Scale to apply to `d` (vectors only). */
  sx: number
  sy: number
  /** Whether the stroke can be inset/outset geometrically. */
  offsettable: boolean
}

/** Outline of a node in its local coordinate space. `inset` > 0 shrinks rect/ellipse shapes. */
export function nodeShape(n: SceneNode, inset = 0): NodeShape | null {
  const w = n.width - inset * 2
  const h = n.height - inset * 2
  switch (n.type) {
    case 'TEXT':
      return null
    case 'ELLIPSE':
      return { d: ellipsePath(inset, inset, Math.max(0, w), Math.max(0, h)), sx: 1, sy: 1, offsettable: true }
    case 'LINE':
      return { d: `M0 0L${f(n.width)} 0`, sx: 1, sy: 1, offsettable: false }
    case 'POLYGON':
    case 'STAR':
      return { d: polyPath(n), sx: 1, sy: 1, offsettable: false }
    case 'VECTOR':
      return {
        d: n.vectorPath || '',
        sx: n.width / (n.vectorWidth || n.width || 1),
        sy: n.height / (n.vectorHeight || n.height || 1),
        offsettable: false,
      }
    default:
      return {
        d: roundRectPath(inset, inset, Math.max(0, w), Math.max(0, h), radiiOf(n).map((r) => (r ? Math.max(0, r - inset) : 0))),
        sx: 1,
        sy: 1,
        offsettable: true,
      }
  }
}

/** How far the stroke path is inset from the shape outline, per stroke alignment. */
export function strokeInset(n: SceneNode, shape: NodeShape): number {
  const sw = n.strokeWeight ?? 1
  if (!shape.offsettable) return 0
  const align = n.strokeAlign ?? 'INSIDE'
  return align === 'INSIDE' ? sw / 2 : align === 'OUTSIDE' ? -sw / 2 : 0
}

export const visiblePaints = (paints?: Paint[]) => (paints ?? []).filter((p) => p.visible !== false && (p.opacity ?? 1) > 0)

/** Start/end points (in local px) of a linear gradient with the given angle. */
export function gradientLine(angle: number, w: number, h: number) {
  const r = (angle * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const half = (Math.abs(w * c) + Math.abs(h * s)) / 2
  return { x1: w / 2 - c * half, y1: h / 2 - s * half, x2: w / 2 + c * half, y2: h / 2 + s * half }
}

/** Open arrowheads for lines with arrowStart / arrowEnd (path data in the line's local space). */
export function arrowHeads(n: SceneNode): string {
  if (n.type !== 'LINE' || (!n.arrowEnd && !n.arrowStart)) return ''
  const s = Math.max(4, (n.strokeWeight ?? 1) * 3 + 3)
  let d = ''
  if (n.arrowEnd) d += `M${f(n.width - s)} ${f(-s)}L${f(n.width)} 0L${f(n.width - s)} ${f(s)}`
  if (n.arrowStart) d += `M${f(s)} ${f(-s)}L0 0L${f(s)} ${f(s)}`
  return d
}
