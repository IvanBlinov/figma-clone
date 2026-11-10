// Mermaid (flowchart / graph, stateDiagram, erDiagram, sequenceDiagram, gantt) → scene nodes.
import { estimateMeasure } from '../shared/text'
import { newId, type Paint, type SceneNode } from '../shared/types'

type Shape = 'rect' | 'round' | 'pill' | 'diamond' | 'circle' | 'dot'
interface GNode {
  id: string
  text: string
  shape: Shape
  fill?: string
  stroke?: string
  color?: string
  rows?: string[]
  w: number
  h: number
  x: number
  y: number
}
interface GEdge {
  from: string
  to: string
  label?: string
  dashed?: boolean
  arrow: boolean
}

const solid = (color: string): Paint[] => [{ type: 'SOLID', color }]
const unq = (s: string) => s.trim().replace(/^["'`]|["'`]$/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n')
const textW = (t: string, size: number, weight = 400) => Math.max(...t.split('\n').map((l) => estimateMeasure(l, { fontSize: size, fontWeight: weight } as SceneNode)))

class Builder {
  nodes: SceneNode[] = []
  private order = 0
  constructor(readonly rootId: string) {}
  add(n: Partial<SceneNode> & { type: SceneNode['type']; name: string }, parentId = this.rootId): string {
    const id = newId()
    this.nodes.push({ id, order: this.order++, x: 0, y: 0, width: 100, height: 100, parentId, ...n } as SceneNode)
    return id
  }
  text(characters: string, x: number, y: number, o: Partial<SceneNode> = {}, parentId = this.rootId) {
    const size = (o.fontSize as number) ?? 13
    const w = textW(characters, size, (o.fontWeight as number) ?? 400)
    return this.add({ type: 'TEXT', name: characters.split('\n')[0].slice(0, 40), characters, x, y, width: Math.ceil(w), height: Math.ceil(size * 1.21) * characters.split('\n').length, fontSize: size, fontFamily: 'Inter', fontWeight: 400, fills: solid('#1E1E1E'), textAutoResize: 'WIDTH_AND_HEIGHT', ...o }, parentId)
  }
  line(x1: number, y1: number, x2: number, y2: number, o: Partial<SceneNode> = {}) {
    return this.add({ type: 'LINE', name: 'Connector', x: x1, y: y1, width: Math.round(Math.hypot(x2 - x1, y2 - y1) * 100) / 100, height: 0, rotation: Math.round(((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) * 100) / 100, strokes: solid('#6B6B6B'), strokeWeight: 1.5, strokeAlign: 'CENTER', ...o })
  }
  label(t: string, cx: number, cy: number) {
    const w = textW(t, 11) + 8
    const f = this.add({ type: 'FRAME', name: 'Label', x: Math.round(cx - w / 2), y: Math.round(cy - 9), width: w, height: 18, fills: solid('#FFFFFF'), cornerRadius: 4, layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', paddingLeft: 4, paddingRight: 4, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'FIXED' })
    this.text(t, 0, 0, { fontSize: 11, fills: solid('#555555') }, f)
  }
}

function drawGraphNode(b: Builder, n: GNode) {
  const fill = n.fill ?? (n.shape === 'dot' ? '#1E1E1E' : '#E5F4FF')
  const stroke = n.stroke ?? (n.shape === 'dot' ? '#1E1E1E' : '#0D99FF')
  const f = b.add({ type: 'FRAME', name: n.text.split('\n')[0] || n.id, x: n.x, y: n.y, width: n.w, height: n.h, fills: [], clipsContent: false, layoutMode: 'VERTICAL', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', itemSpacing: 4 })
  const common = { x: 0, y: 0, width: n.w, height: n.h, fills: solid(fill), strokes: solid(stroke), strokeWeight: 1.5, layoutPositioning: 'ABSOLUTE' as const, constraints: { horizontal: 'STRETCH' as const, vertical: 'STRETCH' as const } }
  if (n.shape === 'diamond') b.add({ type: 'POLYGON', name: 'Shape', pointCount: 4, ...common, strokeAlign: 'CENTER' }, f)
  else if (n.shape === 'circle' || n.shape === 'dot') b.add({ type: 'ELLIPSE', name: 'Shape', ...common }, f)
  else b.add({ type: 'RECTANGLE', name: 'Shape', ...common, cornerRadius: n.shape === 'pill' ? n.h / 2 : n.shape === 'round' ? 12 : 4 }, f)
  if (n.text) b.text(n.text, 0, 0, { fontWeight: n.rows ? 600 : 500, textAlignHorizontal: 'CENTER', fills: solid(n.color ?? '#1E1E1E') }, f)
  for (const r of n.rows ?? []) b.text(r, 0, 0, { fontSize: 11, fills: solid('#555555') }, f)
}

/** Point where the segment from the centre of `a` towards `p` leaves the box of `a`. */
function exit(a: GNode, px: number, py: number): [number, number] {
  const cx = a.x + a.w / 2
  const cy = a.y + a.h / 2
  const dx = px - cx
  const dy = py - cy
  if (!dx && !dy) return [cx, cy]
  if (a.shape === 'circle' || a.shape === 'dot') {
    const k = 1 / Math.hypot(dx / (a.w / 2), dy / (a.h / 2))
    return [cx + dx * k, cy + dy * k]
  }
  if (a.shape === 'diamond') {
    const k = 1 / (Math.abs(dx) / (a.w / 2) + Math.abs(dy) / (a.h / 2))
    return [cx + dx * k, cy + dy * k]
  }
  const k = Math.min(dx ? a.w / 2 / Math.abs(dx) : Infinity, dy ? a.h / 2 / Math.abs(dy) : Infinity)
  return [cx + dx * k, cy + dy * k]
}

function layoutGraph(b: Builder, nodes: Map<string, GNode>, edges: GEdge[], dir: string) {
  const list = [...nodes.values()]
  for (const n of list) {
    const lines = [n.text, ...(n.rows ?? [])]
    const tw = Math.max(...lines.map((l, i) => textW(l, i ? 11 : 13, 500)))
    n.w = n.shape === 'dot' ? 20 : Math.max(n.shape === 'diamond' ? 110 : 90, Math.ceil(tw) + (n.shape === 'diamond' ? 64 : 32))
    n.h = n.shape === 'dot' ? 20 : n.shape === 'diamond' ? 72 : n.shape === 'circle' ? Math.max(64, n.w) : 44 + (n.rows?.length ?? 0) * 18 + Math.max(0, n.text.split('\n').length - 1) * 16
    if (n.shape === 'circle') n.w = n.h
  }
  // Longest-path layering; edges that close a cycle are ignored for ranking.
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const rank = new Map<string, number>()
  const state = new Map<string, number>()
  const visit = (id: string, r: number) => {
    if (state.get(id) === 1) return
    if ((rank.get(id) ?? -1) >= r && state.get(id) === 2) return
    rank.set(id, Math.max(rank.get(id) ?? 0, r))
    state.set(id, 1)
    for (const t of out.get(id) ?? []) visit(t, r + 1)
    state.set(id, 2)
  }
  const targets = new Set(edges.map((e) => e.to))
  for (const n of list) if (!targets.has(n.id)) visit(n.id, 0)
  for (const n of list) if (!rank.has(n.id)) visit(n.id, 0)
  const layers: GNode[][] = []
  for (const n of list) (layers[rank.get(n.id)!] ??= []).push(n)
  const horizontal = dir === 'LR' || dir === 'RL'
  const gapMain = 80
  const gapCross = 36
  const cross = (n: GNode) => (horizontal ? n.h : n.w)
  const main = (n: GNode) => (horizontal ? n.w : n.h)
  const span = Math.max(...layers.map((l) => l.reduce((s, n) => s + cross(n), 0) + gapCross * (l.length - 1)))
  let pos = 0
  for (const layer of layers.filter(Boolean)) {
    const size = Math.max(...layer.map(main))
    let c = (span - (layer.reduce((s, n) => s + cross(n), 0) + gapCross * (layer.length - 1))) / 2
    for (const n of layer) {
      const m = pos + (size - main(n)) / 2
      n.x = Math.round(horizontal ? m : c)
      n.y = Math.round(horizontal ? c : m)
      c += cross(n) + gapCross
    }
    pos += size + gapMain
  }
  if (dir === 'RL' || dir === 'BT') {
    const total = pos - gapMain
    for (const n of list) {
      if (dir === 'RL') n.x = total - n.x - n.w
      else n.y = total - n.y - n.h
    }
  }
  for (const e of edges) {
    const a = nodes.get(e.from)!
    const c = nodes.get(e.to)!
    if (a === c) continue
    const [x1, y1] = exit(a, c.x + c.w / 2, c.y + c.h / 2)
    const [x2, y2] = exit(c, a.x + a.w / 2, a.y + a.h / 2)
    b.line(x1, y1, x2, y2, { ...(e.arrow ? { arrowEnd: true } : {}), ...(e.dashed ? { dashPattern: [5, 4] } : {}) })
    if (e.label) b.label(e.label, (x1 + x2) / 2, (y1 + y2) / 2)
  }
  for (const n of list) drawGraphNode(b, n)
}

function parseFlow(lines: string[], nodes: Map<string, GNode>, edges: GEdge[]) {
  const ensure = (id: string, text?: string, shape?: Shape) => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, (n = { id, text: text ?? id, shape: shape ?? 'rect', w: 0, h: 0, x: 0, y: 0 }))
    else if (text !== undefined) {
      n.text = text
      n.shape = shape ?? n.shape
    }
    return n
  }
  const nodeRe = /^\s*([\w.]+(?:-[\w.]+)*)\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\(([^)]*)\)\]|\[([^\]]*)\]|\(([^)]*)\)|\{\{?([^}]*)\}?\}|>([^\]]*)\])?/
  const edgeRe = /^\s*(?:(-\.+->|-\.+-|==+>|==+|--+>|--+|<--+>)\s*(?:\|([^|]*)\|)?|(--|==|-\.)\s*([^-=.|>][^>]*?)\s*(--+>|==+>|\.+->|--+|==+|\.+-))/
  for (const raw of lines) {
    let s = raw.trim()
    if (!s || /^(subgraph|end|direction|classDef|class |click|linkStyle|%%)/.test(s)) continue
    const st = s.match(/^style\s+([\w.-]+)\s+(.*)$/)
    if (st) {
      const n = ensure(st[1])
      for (const part of st[2].split(',')) {
        const [k, v] = part.split(':').map((x) => x.trim())
        const hex = /^#[0-9a-f]{3,8}$/i.test(v ?? '') ? (v.length === 4 ? '#' + v.slice(1).split('').map((c) => c + c).join('') : v.slice(0, 7)).toUpperCase() : undefined
        if (hex && k === 'fill') n.fill = hex
        if (hex && k === 'stroke') n.stroke = hex
        if (hex && k === 'color') n.color = hex
      }
      continue
    }
    let prev: GNode[] | null = null
    let pending: { label?: string; dashed: boolean; arrow: boolean } | null = null
    let guard = 0
    while (s && guard++ < 50) {
      const group: GNode[] = []
      for (;;) {
        const m = s.match(nodeRe)
        if (!m) break
        const text = m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9]
        const shape: Shape | undefined = m[3] !== undefined ? 'circle' : m[4] !== undefined ? 'pill' : m[5] !== undefined ? 'round' : m[6] !== undefined ? 'rect' : m[7] !== undefined ? 'round' : m[8] !== undefined ? 'diamond' : m[9] !== undefined ? 'rect' : undefined
        group.push(ensure(m[1], text !== undefined ? unq(text) : undefined, shape))
        s = s.slice(m[0].length)
        const amp = s.match(/^\s*&\s*/)
        if (!amp) break
        s = s.slice(amp[0].length)
      }
      if (!group.length) break
      if (prev && pending) for (const a of prev) for (const c of group) edges.push({ from: a.id, to: c.id, ...pending })
      const e = s.match(edgeRe)
      if (!e) break
      const op = e[1] ?? e[5]
      pending = { label: e[2] !== undefined ? unq(e[2]) : e[4] !== undefined ? unq(e[4]) : undefined, dashed: (e[1] ?? e[3] ?? '').includes('.'), arrow: op.includes('>') }
      prev = group
      s = s.slice(e[0].length)
    }
  }
}

function parseState(lines: string[], nodes: Map<string, GNode>, edges: GEdge[]) {
  let stars = 0
  const ensure = (raw: string, end: boolean) => {
    const id = raw.trim()
    if (id === '[*]') {
      const sid = `__${end ? 'end' : 'start'}${stars++}`
      nodes.set(sid, { id: sid, text: '', shape: 'dot', w: 0, h: 0, x: 0, y: 0 })
      return sid
    }
    if (!nodes.has(id)) nodes.set(id, { id, text: id, shape: 'pill', w: 0, h: 0, x: 0, y: 0 })
    return id
  }
  for (const raw of lines) {
    const s = raw.trim()
    const alias = s.match(/^state\s+"([^"]*)"\s+as\s+([\w.-]+)/)
    if (alias) {
      ensure(alias[2], false)
      nodes.get(alias[2])!.text = alias[1]
      continue
    }
    const desc = s.match(/^([\w.-]+)\s*:\s*(.+)$/)
    if (desc && !s.includes('-->')) {
      ensure(desc[1], false)
      nodes.get(desc[1])!.text = desc[2]
      continue
    }
    const t = s.match(/^(\[\*\]|[\w.]+(?:-[\w.]+)*)\s*-->\s*(\[\*\]|[\w.]+(?:-[\w.]+)*)\s*(?::\s*(.*))?$/)
    if (t) edges.push({ from: ensure(t[1], false), to: ensure(t[2], true), label: t[3]?.trim() || undefined, arrow: true })
  }
}

function parseEr(lines: string[], nodes: Map<string, GNode>, edges: GEdge[]) {
  const ensure = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, text: id, shape: 'rect', rows: [], w: 0, h: 0, x: 0, y: 0 })
    return nodes.get(id)!
  }
  let open: GNode | null = null
  for (const raw of lines) {
    const s = raw.trim()
    if (!s) continue
    if (open) {
      if (s === '}') open = null
      else open.rows!.push(s.replace(/\s+/g, ' '))
      continue
    }
    const block = s.match(/^([\w-]+)\s*\{$/)
    if (block) {
      open = ensure(block[1])
      continue
    }
    const rel = s.match(/^([\w-]+)\s+([|}o][|o]?(?:--|\.\.)[|o]?[|{o])\s+([\w-]+)\s*(?::\s*(.*))?$/)
    if (rel) {
      ensure(rel[1])
      ensure(rel[3])
      edges.push({ from: rel[1], to: rel[3], label: rel[4] ? unq(rel[4]) : undefined, dashed: rel[2].includes('..'), arrow: false })
    } else if (/^[\w-]+$/.test(s)) ensure(s)
  }
}

function drawSequence(b: Builder, lines: string[]) {
  const actors: { id: string; label: string }[] = []
  const ensure = (id: string, label?: string) => {
    let a = actors.find((x) => x.id === id)
    if (!a) actors.push((a = { id, label: label ?? id }))
    else if (label) a.label = label
    return a
  }
  const msgs: { from: string; to: string; text: string; dashed: boolean }[] = []
  for (const raw of lines) {
    const s = raw.trim()
    const p = s.match(/^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/)
    if (p) {
      ensure(p[1], p[2] ? unq(p[2]) : undefined)
      continue
    }
    const m = s.match(/^([\w.]+(?:-[\w.]+)*)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?([\w.]+(?:-[\w.]+)*)\s*:\s*(.*)$/)
    if (m) {
      ensure(m[1])
      ensure(m[3])
      msgs.push({ from: m[1], to: m[3], text: unq(m[4]), dashed: m[2].startsWith('--') })
    }
  }
  const colW = Math.max(160, ...actors.map((a) => textW(a.label, 13, 600) + 60), ...msgs.map((m) => (textW(m.text, 12) + 40) / Math.max(1, Math.abs(actors.findIndex((a) => a.id === m.from) - actors.findIndex((a) => a.id === m.to)))))
  const cx = (id: string) => actors.findIndex((a) => a.id === id) * colW + colW / 2
  const bottom = 70 + msgs.length * 48 + 20
  actors.forEach((a, i) => {
    b.line(i * colW + colW / 2, 44, i * colW + colW / 2, bottom, { strokes: solid('#BDBDBD'), dashPattern: [4, 4], strokeWeight: 1 })
    for (const y of [0, bottom]) {
      const f = b.add({ type: 'FRAME', name: a.label, x: i * colW + 20, y, width: colW - 40, height: 44, fills: solid('#E5F4FF'), strokes: solid('#0D99FF'), strokeWeight: 1.5, cornerRadius: 6, layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' })
      b.text(a.label, 0, 0, { fontWeight: 600 }, f)
    }
  })
  msgs.forEach((m, i) => {
    const y = 80 + i * 48
    const x1 = cx(m.from)
    const x2 = cx(m.to)
    if (x1 === x2) {
      b.line(x1, y, x1 + 40, y, m.dashed ? { dashPattern: [5, 4] } : {})
      b.line(x1 + 40, y, x1 + 40, y + 18)
      b.line(x1 + 40, y + 18, x1, y + 18, { arrowEnd: true })
      b.text(m.text, x1 + 48, y, { fontSize: 12 })
    } else {
      b.line(x1, y, x2, y, { arrowEnd: true, ...(m.dashed ? { dashPattern: [5, 4] } : {}) })
      b.text(m.text, Math.round((x1 + x2) / 2 - textW(m.text, 12) / 2), y - 20, { fontSize: 12 })
    }
  })
}

function drawGantt(b: Builder, lines: string[]) {
  interface Task { name: string; id?: string; section: string; start: number; days: number }
  const tasks: Task[] = []
  let section = ''
  let title = ''
  const dur = (s: string) => {
    const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([dwhm])$/i)
    return m ? +m[1] * ({ d: 1, w: 7, h: 1 / 24, m: 30 }[m[2].toLowerCase() as 'd'] ?? 1) : null
  }
  let origin: number | null = null
  for (const raw of lines) {
    const s = raw.trim()
    if (!s || /^(dateFormat|axisFormat|excludes|todayMarker|tickInterval|weekday)/.test(s)) continue
    if (s.startsWith('title')) {
      title = s.slice(5).trim()
      continue
    }
    if (s.startsWith('section')) {
      section = s.slice(7).trim()
      continue
    }
    const m = s.match(/^([^:]+):(.*)$/)
    if (!m) continue
    const parts = m[2].split(',').map((x) => x.trim()).filter((x) => x && !['done', 'active', 'crit', 'milestone'].includes(x))
    const prev = tasks[tasks.length - 1]
    let start = prev ? prev.start + prev.days : 0
    let days = 1
    let id: string | undefined
    for (const p of parts) {
      const d = dur(p)
      const after = p.match(/^after\s+([\w-]+)/)
      if (d !== null) days = d
      else if (after) {
        const ref = tasks.find((t) => t.id === after[1])
        if (ref) start = ref.start + ref.days
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
        const t = Date.parse(p) / 86400000
        if (origin === null) origin = t
        if (parts.indexOf(p) === parts.length - 1 && parts.length > 1 && parts.some((q) => q !== p && /^\d{4}-\d{2}-\d{2}$/.test(q))) days = Math.max(1, t - origin - start)
        else start = t - origin
      } else id = p
    }
    tasks.push({ name: m[1].trim(), id, section, start, days })
  }
  const total = Math.max(1, ...tasks.map((t) => t.start + t.days))
  const labelW = Math.max(120, ...tasks.map((t) => textW(t.name, 12) + 16))
  const chartW = 640
  const k = chartW / total
  const colors = ['#0D99FF', '#14AE5C', '#9747FF', '#FFA629', '#F24822', '#00B5CE']
  const sections = [...new Set(tasks.map((t) => t.section))]
  let y = 0
  if (title) {
    b.text(title, 0, 0, { fontSize: 16, fontWeight: 700 })
    y = 36
  }
  let last = '\u0000'
  for (const t of tasks) {
    if (t.section !== last) {
      last = t.section
      if (t.section) {
        b.text(t.section, 0, y, { fontSize: 11, fontWeight: 600, fills: solid('#7A7A7A') })
        y += 22
      }
    }
    b.text(t.name, 0, y + 6, { fontSize: 12 })
    b.add({ type: 'RECTANGLE', name: t.name, x: Math.round(labelW + t.start * k), y, width: Math.max(4, Math.round(t.days * k)), height: 26, cornerRadius: 5, fills: solid(colors[sections.indexOf(t.section) % colors.length]) })
    y += 34
  }
  b.line(labelW, y + 4, labelW + chartW, y + 4, { strokes: solid('#BDBDBD'), strokeWeight: 1 })
}

/** Build a diagram as a frame of editable layers. Returns nodes with the root frame first. */
export function buildDiagram(name: string, mermaid: string, x = 0, y = 0): SceneNode[] {
  const all = mermaid.split(/\r?\n/).flatMap((l) => l.split(';')).map((l) => l.replace(/%%.*$/, ''))
  const first = all.findIndex((l) => l.trim())
  const header = (all[first] ?? '').trim()
  const body = all.slice(first + 1)
  const rootId = newId()
  const b = new Builder(rootId)
  const kind = header.split(/\s+/)[0]
  if (kind === 'graph' || kind === 'flowchart' || kind.startsWith('stateDiagram') || kind === 'erDiagram') {
    const nodes = new Map<string, GNode>()
    const edges: GEdge[] = []
    let dir = (header.split(/\s+/)[1] ?? 'LR').toUpperCase()
    if (dir === 'TD') dir = 'TB'
    if (kind === 'graph' || kind === 'flowchart') parseFlow(body, nodes, edges)
    else if (kind === 'erDiagram') {
      parseEr(body, nodes, edges)
      dir = 'LR'
    } else {
      const d = body.find((l) => /^\s*direction\s+/.test(l))
      dir = d ? d.trim().split(/\s+/)[1].toUpperCase() : 'TB'
      parseState(body, nodes, edges)
    }
    if (!nodes.size) throw new Error('No nodes found in the Mermaid source. Example: flowchart LR\\n  A["Start"] --> B{"OK?"} -->|"yes"| C["Done"]')
    layoutGraph(b, nodes, edges, dir)
  } else if (kind === 'sequenceDiagram') drawSequence(b, body)
  else if (kind === 'gantt') drawGantt(b, body)
  else throw new Error(`Unsupported diagram type "${kind}". Supported: graph, flowchart, sequenceDiagram, stateDiagram, stateDiagram-v2, gantt, erDiagram`)
  if (!b.nodes.length) throw new Error('The Mermaid source produced no shapes')
  // Fit the root frame around the content with padding.
  const pad = 40
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of b.nodes) {
    if (n.parentId !== rootId) continue
    const r = ((n.rotation ?? 0) * Math.PI) / 180
    const ex = n.x + Math.cos(r) * n.width
    const ey = n.y + Math.sin(r) * n.width
    minX = Math.min(minX, n.x, ex)
    minY = Math.min(minY, n.y, ey)
    maxX = Math.max(maxX, n.x + (n.type === 'LINE' ? 0 : n.width), ex)
    maxY = Math.max(maxY, n.y + n.height, ey)
  }
  for (const n of b.nodes)
    if (n.parentId === rootId) {
      n.x += pad - minX
      n.y += pad - minY
    }
  const root: SceneNode = { id: rootId, order: 0, type: 'FRAME', name, x, y, width: Math.ceil(maxX - minX + pad * 2), height: Math.ceil(maxY - minY + pad * 2), fills: solid('#FFFFFF'), cornerRadius: 8, clipsContent: false }
  return [root, ...b.nodes]
}
