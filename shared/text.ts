import type { SceneNode, TextRun, TextRunStyle } from './types'

/** Width in px of a single line of text rendered with the node's font settings. */
export type MeasureFn = (text: string, n: SceneNode) => number

export const fontSizeOf = (n: SceneNode) => n.fontSize ?? 12
export const lineHeightOf = (n: SceneNode) => n.lineHeight ?? Math.round(fontSizeOf(n) * 1.21 * 100) / 100

export function fontString(n: SceneNode): string {
  return `${n.italic ? 'italic ' : ''}${n.fontWeight ?? 400} ${fontSizeOf(n)}px "${n.fontFamily ?? 'Inter'}", Inter, system-ui, sans-serif`
}

export function casedText(n: SceneNode): string {
  const t = n.characters ?? ''
  switch (n.textCase) {
    case 'UPPER':
      return t.toUpperCase()
    case 'LOWER':
      return t.toLowerCase()
    case 'TITLE':
      return t.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    default:
      return t
  }
}

export interface TextSeg {
  text: string
  start: number
  /** Offset from the start of the line. */
  x: number
  width: number
  /** Node with the run's overrides applied — pass to measure / fontString. */
  style: SceneNode
  run: TextRun | null
}
export interface TextLine {
  start: number
  end: number
  text: string
  width: number
  height: number
  /** Top of the line relative to the first line's top. */
  y: number
  /** Baseline offset from the line top. */
  baseline: number
  segs: TextSeg[]
}
export interface TextLayout {
  lines: TextLine[]
  width: number
  height: number
  text: string
}

/** Runs clipped to the text, sorted, non-overlapping. */
export function cleanRuns(runs: TextRun[] | undefined, length: number): TextRun[] {
  if (!runs?.length) return []
  const out: TextRun[] = []
  let pos = 0
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    const start = Math.max(pos, r.start)
    const end = Math.min(length, r.end)
    if (end <= start || !r.style || !Object.keys(r.style).length) continue
    out.push({ start, end, style: r.style })
    pos = end
  }
  return out
}

interface Ctx {
  n: SceneNode
  text: string
  runs: TextRun[]
  styles: SceneNode[]
  measure: MeasureFn
}

function makeCtx(n: SceneNode, measure: MeasureFn): Ctx {
  const text = casedText(n)
  const runs = text.length === (n.characters ?? '').length ? cleanRuns(n.textRuns, text.length) : []
  return { n, text, runs, styles: runs.map((r) => ({ ...n, ...r.style }) as SceneNode), measure }
}

function pieces(c: Ctx, a: number, b: number): TextSeg[] {
  const out: TextSeg[] = []
  let x = 0
  const push = (s: number, e: number, style: SceneNode, run: TextRun | null) => {
    if (e <= s) return
    const text = c.text.slice(s, e)
    const width = c.measure(text, style)
    out.push({ text, start: s, x, width, style, run })
    x += width
  }
  let pos = a
  for (let i = 0; i < c.runs.length && pos < b; i++) {
    const r = c.runs[i]
    if (r.end <= pos) continue
    if (r.start >= b) break
    push(pos, Math.min(r.start, b), c.n, null)
    push(Math.max(pos, r.start), Math.min(r.end, b), c.styles[i], r)
    pos = Math.max(pos, Math.min(r.end, b))
  }
  push(pos, b, c.n, null)
  return out
}

function widthOf(c: Ctx, a: number, b: number): number {
  if (b <= a) return 0
  if (!c.runs.length) return c.measure(c.text.slice(a, b), c.n)
  let w = 0
  for (const p of pieces(c, a, b)) w += p.width
  return w
}

export function layoutText(n: SceneNode, measure: MeasureFn, maxWidth?: number): TextLayout {
  const c = makeCtx(n, measure)
  const { text } = c
  const spans: [number, number][] = []
  const trim = (s: number, e: number) => {
    while (e > s && /\s/.test(text[e - 1])) e--
    return e
  }
  let ps = 0
  while (ps <= text.length) {
    let pe = text.indexOf('\n', ps)
    if (pe === -1) pe = text.length
    if (maxWidth == null || widthOf(c, ps, pe) <= maxWidth) spans.push([ps, pe])
    else {
      const re = /(\s+)|(\S+)/g
      const para = text.slice(ps, pe)
      let ls = ps
      let le = ps
      let m: RegExpExecArray | null
      while ((m = re.exec(para))) {
        const ts = ps + m.index
        const te = ts + m[0].length
        const isSpace = !!m[1]
        if (isSpace || widthOf(c, ls, te) <= maxWidth) {
          if (isSpace && le === ls) {
            ls = le = te
            continue
          }
          le = te
          continue
        }
        if (le > ls) spans.push([ls, trim(ls, le)])
        if (widthOf(c, ts, te) > maxWidth) {
          // Word longer than the box: break it by characters.
          let cs = ts
          let i = ts
          for (const ch of text.slice(ts, te)) {
            if (i > cs && widthOf(c, cs, i + ch.length) > maxWidth) {
              spans.push([cs, i])
              cs = i
            }
            i += ch.length
          }
          ls = cs
        } else ls = ts
        le = te
      }
      spans.push([ls, trim(ls, le)])
    }
    ps = pe + 1
  }

  const baseFs = fontSizeOf(n)
  const lines: TextLine[] = []
  let y = 0
  let width = 0
  for (const [a, b] of spans) {
    const segs = pieces(c, a, b)
    let fs = segs.length ? 0 : baseFs
    for (const s of segs) fs = Math.max(fs, fontSizeOf(s.style))
    // An empty line takes the size of the run it sits in (or the base style).
    if (!segs.length && c.runs.length) {
      const i = c.runs.findIndex((r) => r.start <= a && r.end > a)
      if (i >= 0) fs = fontSizeOf(c.styles[i])
    }
    const height = n.lineHeight ?? Math.round(fs * 1.21 * 100) / 100
    const w = segs.reduce((s, p) => s + p.width, 0)
    lines.push({ start: a, end: b, text: text.slice(a, b), width: w, height, y, baseline: (height - fs * 1.21) / 2 + fs * 0.969, segs })
    y += height
    width = Math.max(width, w)
  }
  return { lines, width, height: Math.max(y, 1), text }
}

/** Width at which the node's text wraps (undefined = never). */
export const wrapWidthOf = (n: SceneNode) => ((n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT' ? undefined : n.width)

/** Where the text block sits inside the node box. */
export function textOrigin(n: SceneNode, t: TextLayout) {
  const vAlign = n.textAlignVertical ?? 'TOP'
  const top = vAlign === 'CENTER' ? (n.height - t.height) / 2 : vAlign === 'BOTTOM' ? n.height - t.height : 0
  const hAlign = n.textAlignHorizontal ?? 'LEFT'
  const lineX = (line: TextLine) => (hAlign === 'CENTER' ? (n.width - line.width) / 2 : hAlign === 'RIGHT' ? n.width - line.width : 0)
  return { top, lineX }
}

export function lineIndexOf(t: TextLayout, index: number): number {
  let li = 0
  for (let i = 0; i < t.lines.length; i++) if (t.lines[i].start <= index) li = i
  return li
}

/** Caret rectangle (node-local) for a character index. */
export function caretRect(n: SceneNode, t: TextLayout, measure: MeasureFn, index: number): { x: number; y: number; h: number; line: number } {
  const li = lineIndexOf(t, index)
  const line = t.lines[li]
  const o = textOrigin(n, t)
  const c = makeCtx(n, measure)
  const i = Math.max(line.start, Math.min(index, line.end))
  return { x: o.lineX(line) + widthOf(c, line.start, i), y: o.top + line.y, h: line.height, line: li }
}

/** Character index closest to a node-local point. */
export function indexAtPoint(n: SceneNode, t: TextLayout, measure: MeasureFn, x: number, y: number, lineHint?: number): number {
  const o = textOrigin(n, t)
  let li = lineHint ?? t.lines.length - 1
  if (lineHint == null)
    for (let i = 0; i < t.lines.length; i++)
      if (y < o.top + t.lines[i].y + t.lines[i].height) {
        li = i
        break
      }
  const line = t.lines[Math.max(0, Math.min(li, t.lines.length - 1))]
  const c = makeCtx(n, measure)
  const lx = x - o.lineX(line)
  let best = line.start
  let bestD = Infinity
  let i = line.start
  const consider = (idx: number) => {
    const d = Math.abs(widthOf(c, line.start, idx) - lx)
    if (d < bestD) {
      bestD = d
      best = idx
    }
  }
  consider(i)
  for (const ch of line.text) {
    i += ch.length
    consider(i)
  }
  return best
}

/** Selection highlight rectangles (node-local) for a character range. */
export function selectionRects(n: SceneNode, t: TextLayout, measure: MeasureFn, a: number, b: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = []
  const o = textOrigin(n, t)
  const c = makeCtx(n, measure)
  for (const line of t.lines) {
    if (b < line.start || a > line.end) continue
    const s = Math.max(a, line.start)
    const e = Math.min(b, line.end)
    const x0 = o.lineX(line) + widthOf(c, line.start, s)
    let w = widthOf(c, s, e)
    if (b > line.end && w < 4) w += 4 // show selected line breaks
    if (e > s || b > line.end) out.push({ x: x0, y: o.top + line.y, w, h: line.height })
  }
  return out
}

export function wordRange(text: string, index: number): [number, number] {
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_'’]/u.test(ch)
  let a = index
  let b = index
  if (!isWord(text[a]) && isWord(text[a - 1])) a--
  if (!isWord(text[a])) return [index, Math.min(text.length, index + 1)]
  while (a > 0 && isWord(text[a - 1])) a--
  b = a
  while (b < text.length && isWord(text[b])) b++
  return [a, b]
}

// ---------- run editing ----------
const sameStyle = (a: TextRunStyle, b: TextRunStyle) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())

function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    if (r.end <= r.start || !Object.keys(r.style).length) continue
    const last = out[out.length - 1]
    if (last && last.end === r.start && sameStyle(last.style, r.style)) last.end = r.end
    else out.push({ start: r.start, end: r.end, style: r.style })
  }
  return out
}

/** Adjust runs after `removed` characters at `at` were replaced by `inserted` characters. Typed text inherits the style before it. */
export function spliceRuns(runs: TextRun[] | undefined, at: number, removed: number, inserted: number): TextRun[] {
  if (!runs?.length) return []
  const delEnd = at + removed
  return mergeRuns(
    runs.map((r) => {
      const start = r.start < at || (r.start === 0 && at === 0) ? r.start : r.start >= delEnd ? r.start - removed + inserted : at + inserted
      const end = r.end < at ? r.end : r.end >= delEnd && r.end > at ? r.end - removed + inserted : at + inserted
      return { start, end, style: r.style }
    }),
  )
}

/** Apply a style patch to [a, b). Keys equal to the node's own value are dropped (the run falls back to the node). */
export function styleRange(n: SceneNode, a: number, b: number, patch: TextRunStyle): TextRun[] {
  const len = (n.characters ?? '').length
  const runs = cleanRuns(n.textRuns, len)
  const cuts = new Set<number>([0, len, a, b])
  for (const r of runs) {
    cuts.add(r.start)
    cuts.add(r.end)
  }
  const pts = [...cuts].filter((v) => v >= 0 && v <= len).sort((x, y) => x - y)
  const base = n as unknown as Record<string, unknown>
  const out: TextRun[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i]
    const e = pts[i + 1]
    const cur = runs.find((r) => r.start <= s && r.end >= e)
    const style: Record<string, unknown> = { ...(cur?.style ?? {}) }
    if (s >= a && e <= b)
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || JSON.stringify(v) === JSON.stringify(base[k] ?? defaultOf(k))) delete style[k]
        else style[k] = v
      }
    out.push({ start: s, end: e, style: style as TextRunStyle })
  }
  return mergeRuns(out)
}

const defaultOf = (k: string): unknown => ({ fontWeight: 400, fontSize: 12, fontFamily: 'Inter', italic: false, textDecoration: 'NONE', letterSpacing: 0 })[k]

/** Effective styles (node + run overrides) covering [a, b) — used to show "mixed" values in the UI. */
export function stylesInRange(n: SceneNode, a: number, b: number): SceneNode[] {
  const len = (n.characters ?? '').length
  const runs = cleanRuns(n.textRuns, len)
  const out: SceneNode[] = []
  let pos = a
  const lo = a === b ? Math.max(0, a - 1) : a
  const hi = a === b ? Math.max(lo + 1, a) : b
  pos = lo
  for (const r of runs) {
    if (r.end <= lo || r.start >= hi) continue
    if (r.start > pos) out.push(n)
    out.push({ ...n, ...r.style } as SceneNode)
    pos = r.end
  }
  if (pos < hi || !out.length) out.push(n)
  return out
}

/** Font-less width estimate used outside the browser (MCP server). The editor re-measures with real fonts. */
export const estimateMeasure: MeasureFn = (text, n) => {
  const fs = fontSizeOf(n)
  const bold = 1 + (((n.fontWeight ?? 400) - 400) / 400) * 0.07
  let w = 0
  for (const ch of text) {
    if (" iljtfI.,;:'|!".includes(ch)) w += 0.29
    else if ('mwMW@%'.includes(ch)) w += 0.86
    else if (ch >= 'A' && ch <= 'Z') w += 0.67
    else if (ch >= '0' && ch <= '9') w += 0.62
    else if (ch.charCodeAt(0) > 0x2e80) w += 1
    else w += 0.55
  }
  return w * fs * bold + (n.letterSpacing ?? 0) * text.length
}
