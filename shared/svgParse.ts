// SVG markup → scene nodes, without a DOM (usable from the MCP server).
import { mul, rotate, translate, type Mat } from './geometry'
import { newId, type Paint, type SceneNode } from './types'
import { parsePath, serializePath, subsBounds, transformSubs } from './vector'

interface El {
  tag: string
  attrs: Record<string, string>
  children: El[]
}

function parseXml(text: string): El | null {
  const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  const re = /<(\/?)([\w:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  const root: El = { tag: '#root', attrs: {}, children: [] }
  const stack: El[] = [root]
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const [, close, tag, rawAttrs, selfClose] = m
    if (close) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    const ar = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    while ((a = ar.exec(rawAttrs))) attrs[a[1]] = a[2] ?? a[3] ?? ''
    const el: El = { tag: tag.toLowerCase(), attrs, children: [] }
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  const find = (e: El): El | null => (e.tag === 'svg' ? e : (e.children.map(find).find(Boolean) ?? null))
  return find(root)
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', gray: '#808080', grey: '#808080', yellow: '#FFFF00',
  orange: '#FFA500', purple: '#800080', pink: '#FFC0CB', navy: '#000080', teal: '#008080', silver: '#C0C0C0', maroon: '#800000', olive: '#808000',
  lime: '#00FF00', aqua: '#00FFFF', cyan: '#00FFFF', fuchsia: '#FF00FF', magenta: '#FF00FF', brown: '#A52A2A', gold: '#FFD700', indigo: '#4B0082',
}

export function parseCssColor(v: string | undefined | null): { color: string; opacity: number } | null {
  if (!v) return null
  const t = v.trim().toLowerCase()
  if (t === 'none' || t === 'transparent') return null
  if (t === 'currentcolor') return { color: '#000000', opacity: 1 }
  if (t.startsWith('url(')) return { color: '#B3B3B3', opacity: 1 }
  if (t.startsWith('#')) {
    let h = t.slice(1)
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return { color: '#000000', opacity: 1 }
    return { color: '#' + h.slice(0, 6).toUpperCase(), opacity: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 }
  }
  const m = t.match(/^rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean)
    const ch = (s: string) => Math.max(0, Math.min(255, Math.round(s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s))))
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])
    return { color: '#' + [p[0], p[1], p[2]].map((s) => ch(s).toString(16).padStart(2, '0')).join('').toUpperCase(), opacity: a }
  }
  return { color: NAMED[t] ?? '#000000', opacity: 1 }
}

function parseTransform(v: string | undefined): Mat {
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

function styleOf(el: El, parent: Style): Style {
  const inline: Record<string, string> = {}
  for (const part of (el.attrs.style ?? '').split(';')) {
    const i = part.indexOf(':')
    if (i > 0) inline[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  const get = (name: string): string | undefined => inline[name] ?? el.attrs[name]
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

function shapePath(el: El): string | null {
  const n = (name: string) => parseFloat(el.attrs[name] ?? '0') || 0
  switch (el.tag) {
    case 'path':
      return el.attrs.d ?? null
    case 'rect': {
      const x = n('x')
      const y = n('y')
      const w = n('width')
      const h = n('height')
      let rx = 'rx' in el.attrs ? n('rx') : n('ry')
      let ry = 'ry' in el.attrs ? n('ry') : rx
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
      const rx = el.tag === 'circle' ? n('r') : n('rx')
      const ry = el.tag === 'circle' ? n('r') : n('ry')
      if (!rx || !ry) return null
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`
    case 'polyline':
    case 'polygon': {
      const pts = (el.attrs.points ?? '').trim().split(/[\s,]+/).map(Number)
      if (pts.length < 4) return null
      let d = ''
      for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`
      return d + (el.tag === 'polygon' ? 'Z' : '')
    }
  }
  return null
}

const SKIP = ['defs', 'clippath', 'mask', 'symbol', 'title', 'desc', 'style', 'metadata', 'lineargradient', 'radialgradient', 'pattern', 'filter']

/**
 * Convert SVG markup into a transparent FRAME holding one VECTOR per shape.
 * Returns the frame first, or null when the markup has no drawable shapes.
 */
export function svgToNodes(text: string, opts: { name?: string; x?: number; y?: number; parentId?: string } = {}): SceneNode[] | null {
  const svg = parseXml(text)
  if (!svg) return null
  const vb = (svg.attrs.viewBox ?? svg.attrs.viewbox ?? '').split(/[\s,]+/).map(Number)
  const hasVb = vb.length === 4 && vb.every((v) => !Number.isNaN(v))
  const width = parseFloat(svg.attrs.width ?? '') || (hasVb ? vb[2] : 100)
  const height = parseFloat(svg.attrs.height ?? '') || (hasVb ? vb[3] : 100)
  const base: Mat = hasVb ? mul([width / (vb[2] || 1), 0, 0, height / (vb[3] || 1), 0, 0], translate(-vb[0], -vb[1])) : [1, 0, 0, 1, 0, 0]
  const frame: SceneNode = {
    id: newId(),
    order: 0,
    type: 'FRAME',
    name: opts.name ?? 'SVG',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width,
    height,
    fills: [],
    clipsContent: false,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  }
  const nodes: SceneNode[] = []
  const root: Style = { fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, fillRule: 'nonzero', linecap: 'butt' }
  const walk = (el: El, m: Mat, style: Style) => {
    if (SKIP.includes(el.tag)) return
    const s = styleOf(el, style)
    const tm = mul(m, parseTransform(el.attrs.transform))
    if (el.tag === 'g' || el.tag === 'svg' || el.tag === 'a') {
      for (const c of el.children) walk(c, tm, s)
      return
    }
    const d = shapePath(el)
    if (!d) return
    const subs = transformSubs(parsePath(d), tm)
    if (!subs.length) return
    const b = subsBounds(subs)
    const w = Math.max(1, Math.round(b.w * 100) / 100)
    const h = Math.max(1, Math.round(b.h * 100) / 100)
    const open = el.tag === 'line' || el.tag === 'polyline'
    const fill = open && !el.attrs.fill ? null : parseCssColor(s.fill)
    const stroke = parseCssColor(s.stroke)
    const scale = Math.sqrt(Math.abs(tm[0] * tm[3] - tm[1] * tm[2])) || 1
    const paint = (c: { color: string; opacity: number }, extra: number): Paint => ({ type: 'SOLID', color: c.color, ...(c.opacity * extra < 1 ? { opacity: c.opacity * extra } : {}) })
    nodes.push({
      id: newId(),
      order: nodes.length,
      type: 'VECTOR',
      name: el.attrs.id || 'Vector',
      parentId: frame.id,
      x: Math.round(b.x * 100) / 100,
      y: Math.round(b.y * 100) / 100,
      width: w,
      height: h,
      vectorPath: serializePath(transformSubs(subs, [1, 0, 0, 1, -b.x, -b.y]), 3),
      vectorWidth: w,
      vectorHeight: h,
      fills: fill ? [paint(fill, s.fillOpacity)] : [],
      strokes: stroke ? [paint(stroke, s.strokeOpacity)] : [],
      strokeWeight: Math.round(s.strokeWidth * scale * 100) / 100,
      strokeAlign: 'CENTER',
      ...(s.fillRule === 'evenodd' ? { vectorFillRule: 'evenodd' as const } : {}),
      ...(s.linecap === 'round' ? { strokeCap: 'ROUND' as const } : s.linecap === 'square' ? { strokeCap: 'SQUARE' as const } : {}),
      ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
    })
  }
  for (const c of svg.children) walk(c, base, styleOf(svg, root))
  return nodes.length ? [frame, ...nodes] : null
}
