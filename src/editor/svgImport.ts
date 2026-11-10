// Paste / drop SVG markup → editable vector nodes.
import { ROOT, nextOrder } from '../../shared/doc'
import { mul, rotate, translate, type Mat, type Pt } from '../../shared/geometry'
import type { Paint, SceneNode } from '../../shared/types'
import { parsePath, serializePath, subsBounds, transformSubs } from '../../shared/vector'
import { makeNode, placement } from './actions'
import { commit, S, screenToWorld } from './store'

const probe = document.createElement('canvas').getContext('2d')!

function parseColor(v: string | undefined | null): { color: string; opacity: number } | null {
  if (!v) return null
  const t = v.trim()
  if (t === 'none' || t === 'transparent') return null
  if (t === 'currentColor' || t.startsWith('url(')) return { color: t.startsWith('url(') ? '#B3B3B3' : '#000000', opacity: 1 }
  probe.fillStyle = '#000000'
  probe.fillStyle = t
  const out = probe.fillStyle
  if (out.startsWith('#')) return { color: out.toUpperCase(), opacity: 1 }
  const m = out.match(/rgba?\(([^)]+)\)/)
  if (!m) return { color: '#000000', opacity: 1 }
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x))
  const hex = '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
  return { color: hex.toUpperCase(), opacity: a ?? 1 }
}

function parseTransform(v: string | null): Mat {
  let m: Mat = [1, 0, 0, 1, 0, 0]
  if (!v) return m
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let t: RegExpExecArray | null
  while ((t = re.exec(v))) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number)
    let n: Mat = [1, 0, 0, 1, 0, 0]
    if (t[1] === 'matrix' && a.length === 6) n = a as Mat
    else if (t[1] === 'translate') n = translate(a[0] ?? 0, a[1] ?? 0)
    else if (t[1] === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
    else if (t[1] === 'rotate') n = a.length >= 3 ? mul(translate(a[1], a[2]), mul(rotate(a[0]), translate(-a[1], -a[2]))) : rotate(a[0] ?? 0)
    else if (t[1] === 'skewX') n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
    else if (t[1] === 'skewY') n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
    m = mul(m, n)
  }
  return m
}

interface Style {
  fill: string
  stroke: string
  strokeWidth: number
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  fillRule: string
  linecap: string
}

function styleOf(el: Element, parent: Style): Style {
  const inline: Record<string, string> = {}
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':')
    if (i > 0) inline[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  const get = (name: string) => inline[name] ?? el.getAttribute(name)
  const num = (name: string, d: number) => {
    const v = get(name)
    return v == null || Number.isNaN(parseFloat(v)) ? d : parseFloat(v)
  }
  return {
    fill: get('fill') ?? parent.fill,
    stroke: get('stroke') ?? parent.stroke,
    strokeWidth: num('stroke-width', parent.strokeWidth),
    opacity: parent.opacity * num('opacity', 1),
    fillOpacity: num('fill-opacity', parent.fillOpacity),
    strokeOpacity: num('stroke-opacity', parent.strokeOpacity),
    fillRule: get('fill-rule') ?? parent.fillRule,
    linecap: get('stroke-linecap') ?? parent.linecap,
  }
}

function shapePath(el: Element): string | null {
  const n = (name: string) => parseFloat(el.getAttribute(name) ?? '0') || 0
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d')
    case 'rect': {
      const x = n('x')
      const y = n('y')
      const w = n('width')
      const h = n('height')
      let rx = el.hasAttribute('rx') ? n('rx') : n('ry')
      let ry = el.hasAttribute('ry') ? n('ry') : rx
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (!w || !h) return null
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx')
      const cy = n('cy')
      const rx = el.tagName.toLowerCase() === 'circle' ? n('r') : n('rx')
      const ry = el.tagName.toLowerCase() === 'circle' ? n('r') : n('ry')
      if (!rx || !ry) return null
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number)
      if (pts.length < 4) return null
      let d = ''
      for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`
      return d + (el.tagName.toLowerCase() === 'polygon' ? 'Z' : '')
    }
  }
  return null
}

/** Convert SVG markup into a frame of vector nodes placed at a world point (default: viewport centre). */
export function importSvg(text: string, at?: Pt, name = 'SVG'): boolean {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg || doc.querySelector('parsererror')) return false
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const hasVb = vb.length === 4 && vb.every((v) => !Number.isNaN(v))
  const width = parseFloat(svg.getAttribute('width') ?? '') || (hasVb ? vb[2] : 100)
  const height = parseFloat(svg.getAttribute('height') ?? '') || (hasVb ? vb[3] : 100)
  const base: Mat = hasVb ? mul([width / (vb[2] || 1), 0, 0, height / (vb[3] || 1), 0, 0], translate(-vb[0], -vb[1])) : [1, 0, 0, 1, 0, 0]

  const st = S()
  const center = at ?? screenToWorld(st.canvasSize.w / 2, st.canvasSize.h / 2)
  const pl = placement(center)
  const frame = makeNode('FRAME', {
    name,
    parentId: pl.parentId,
    x: Math.round(pl.local.x - width / 2),
    y: Math.round(pl.local.y - height / 2),
    width,
    height,
    fills: [],
    clipsContent: false,
  })
  frame.order = nextOrder(st.doc, pl.parentId ?? ROOT)
  const nodes: SceneNode[] = []
  const root: Style = { fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, fillRule: 'nonzero', linecap: 'butt' }

  const walk = (el: Element, m: Mat, style: Style) => {
    const tag = el.tagName.toLowerCase()
    if (['defs', 'clippath', 'mask', 'symbol', 'title', 'desc', 'style', 'metadata', 'lineargradient', 'radialgradient', 'pattern', 'filter'].includes(tag)) return
    const s = styleOf(el, style)
    const tm = mul(m, parseTransform(el.getAttribute('transform')))
    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      for (const c of Array.from(el.children)) walk(c, tm, s)
      return
    }
    const d = shapePath(el)
    if (!d) return
    const subs = transformSubs(parsePath(d), tm)
    if (!subs.length) return
    const b = subsBounds(subs)
    const w = Math.max(1, Math.round(b.w * 100) / 100)
    const h = Math.max(1, Math.round(b.h * 100) / 100)
    const fill = tag === 'line' || tag === 'polyline' ? (el.getAttribute('fill') ? parseColor(s.fill) : null) : parseColor(s.fill)
    const stroke = parseColor(s.stroke)
    const scale = Math.sqrt(Math.abs(tm[0] * tm[3] - tm[1] * tm[2])) || 1
    const fills: Paint[] = fill ? [{ type: 'SOLID', color: fill.color, ...(fill.opacity * s.fillOpacity < 1 ? { opacity: fill.opacity * s.fillOpacity } : {}) }] : []
    const strokes: Paint[] = stroke ? [{ type: 'SOLID', color: stroke.color, ...(stroke.opacity * s.strokeOpacity < 1 ? { opacity: stroke.opacity * s.strokeOpacity } : {}) }] : []
    const node = makeNode('VECTOR', {
      name: el.getAttribute('id') || 'Vector',
      parentId: frame.id,
      x: Math.round(b.x * 100) / 100,
      y: Math.round(b.y * 100) / 100,
      width: w,
      height: h,
      vectorPath: serializePath(transformSubs(subs, [1, 0, 0, 1, -b.x, -b.y]), 3),
      vectorWidth: w,
      vectorHeight: h,
      fills,
      strokes,
      strokeWeight: Math.round(s.strokeWidth * scale * 100) / 100,
      strokeAlign: 'CENTER',
      ...(s.fillRule === 'evenodd' ? { vectorFillRule: 'evenodd' as const } : {}),
      ...(s.linecap === 'round' ? { strokeCap: 'ROUND' as const } : s.linecap === 'square' ? { strokeCap: 'SQUARE' as const } : {}),
      ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
    })
    node.order = nodes.length
    nodes.push(node)
  }
  for (const c of Array.from(svg.children)) walk(c, base, styleOf(svg, root))
  if (!nodes.length) return false
  commit(
    [frame, ...nodes].map((node) => ({ op: 'create' as const, node })),
    { select: [frame.id] },
  )
  return true
}
