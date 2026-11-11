import { booleanPath, fillRuleOf, isBoolean, paintsSelf } from '../../shared/boolean'
import { cssColor, kids, parentOf, ROOT, worldMatrix, type DocIndex } from '../../shared/doc'
import { apply, boundsOf, boxesIntersect, corners, localMatrix, unionBoxes, type Box, type Mat, type Pt } from '../../shared/geometry'
import { arrowHeads, gradientLine, nodeShape, strokeInset, visiblePaints } from '../../shared/paths'
import { caretRect, fontSizeOf, fontString, layoutText, selectionRects, textOrigin, wrapWidthOf } from '../../shared/text'
import type { Paint, SceneNode } from '../../shared/types'
import { segmentsOf } from '../../shared/vector'
import { measureText } from './fonts'
import type { EditorState, Viewport } from './store'
import { editSubs } from './vectorEdit'

export const BLUE = '#0D99FF'
export const PURPLE = '#9747FF'
const RED = '#F24822'

// ---------- caches ----------
const pathCache = new WeakMap<SceneNode, { fill: Path2D; stroke: Path2D }>()
const boolCache = new Map<string, { d: string; p: Path2D }>()
export function pathsOf(ix: DocIndex, n: SceneNode): { fill: Path2D; stroke: Path2D } {
  if (isBoolean(n)) {
    const d = booleanPath(ix, n)
    let c = boolCache.get(n.id)
    if (!c || c.d !== d) boolCache.set(n.id, (c = { d, p: new Path2D(d) }))
    return { fill: c.p, stroke: c.p }
  }
  let c = pathCache.get(n)
  if (!c) {
    const shape = nodeShape(n)!
    const mk = (d: string, sx: number, sy: number) => {
      const p = new Path2D(d)
      if (sx === 1 && sy === 1) return p
      const scaled = new Path2D()
      scaled.addPath(p, new DOMMatrix([sx, 0, 0, sy, 0, 0]))
      return scaled
    }
    const fill = mk(shape.d, shape.sx, shape.sy)
    const inset = strokeInset(n, shape)
    const stroke = inset ? mk(nodeShape(n, inset)!.d, 1, 1) : fill
    pathCache.set(n, (c = { fill, stroke }))
  }
  return c
}

const images = new Map<string, HTMLImageElement | 'loading' | 'error'>()
const imageListeners = new Set<() => void>()
export function setImageLoadCallback(fn: () => void): () => void {
  imageListeners.add(fn)
  return () => void imageListeners.delete(fn)
}
function getImage(url: string): HTMLImageElement | null {
  const hit = images.get(url)
  if (hit) return typeof hit === 'string' ? null : hit
  images.set(url, 'loading')
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    images.set(url, img)
    imageListeners.forEach((fn) => fn())
  }
  img.onerror = () => images.set(url, 'error')
  img.src = url
  return null
}

// ---------- videos ----------
// One muted, looping <video> per URL, kept off-DOM and painted onto the canvas like an image. Canvases that show
// videos call `videosPlayingSince` after each paint and schedule another frame while it returns true.
interface VideoEntry {
  el: HTMLVideoElement
  /** A first frame has been decoded. */
  ready: boolean
  error: boolean
  /** performance.now() of the last live paint that used this video. */
  lastDrawn: number
}
const videos = new Map<string, VideoEntry>()
const videoReadyListeners = new Set<(url: string, el: HTMLVideoElement) => void>()
const repaint = () => imageListeners.forEach((fn) => fn())

/** Called once per video URL when its first frame is available (poster capture). */
export function onVideoReady(fn: (url: string, el: HTMLVideoElement) => void): () => void {
  videoReadyListeners.add(fn)
  return () => void videoReadyListeners.delete(fn)
}
/** The loaded video element for a URL, if this session is showing it. */
export function readyVideo(url: string): HTMLVideoElement | null {
  const e = videos.get(url)
  return e?.ready && !e.error ? e.el : null
}

function getVideo(url: string, live: boolean): VideoEntry | null {
  let e = videos.get(url)
  if (!e) {
    if (!live || !url) return null
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.muted = true
    el.defaultMuted = true
    el.loop = true
    el.playsInline = true
    el.autoplay = true
    el.preload = 'auto'
    el.setAttribute('muted', '')
    el.setAttribute('playsinline', '')
    const entry: VideoEntry = { el, ready: false, error: false, lastDrawn: 0 }
    el.addEventListener('loadeddata', () => {
      entry.ready = true
      videoReadyListeners.forEach((fn) => fn(url, el))
      repaint()
    })
    // `playing` (re)starts the repaint loop of whichever canvas is showing the video.
    el.addEventListener('playing', repaint)
    el.addEventListener('canplay', repaint)
    el.addEventListener('seeked', repaint)
    el.addEventListener('error', () => {
      entry.error = true
      repaint()
    })
    el.src = url
    videos.set(url, (e = entry))
  }
  if (live) {
    e.lastDrawn = performance.now()
    if (!e.error && e.el.paused) void e.el.play().catch(() => {})
  }
  return e
}

/**
 * True while a video painted at or after `t0` (a performance.now() taken just before painting) is playing, i.e. the
 * canvas must paint again next frame. Videos that were not painted are paused, and dropped after a minute unused.
 */
export function videosPlayingSince(t0: number): boolean {
  let playing = false
  for (const [url, e] of videos) {
    if (e.lastDrawn >= t0) {
      if (!e.error && !e.el.paused && !e.el.ended && e.el.readyState >= 2) playing = true
      continue
    }
    if (!e.el.paused) e.el.pause()
    if (t0 - e.lastDrawn > 60_000) {
      e.el.removeAttribute('src')
      e.el.load()
      videos.delete(url)
    }
  }
  return playing
}

/** JPEG still of the video's current frame; null when it cannot be read (tainted canvas, no frame yet). */
export async function captureVideoFrame(el: HTMLVideoElement, maxSize = 1280): Promise<Blob | null> {
  try {
    if (!el.videoWidth || !el.videoHeight || el.readyState < 2) return null
    const s = Math.min(1, maxSize / Math.max(el.videoWidth, el.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(el.videoWidth * s))
    canvas.height = Math.max(1, Math.round(el.videoHeight * s))
    canvas.getContext('2d')!.drawImage(el, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
  } catch {
    return null
  }
}

// ---------- scene ----------
export interface DrawOptions {
  /** Draw layout grids (editor canvas only). */
  grids?: boolean
  /** One-off render (export, thumbnail): use video frames that are already loaded but do not start or keep videos playing. */
  still?: boolean
}
interface DrawCtx {
  ctx: CanvasRenderingContext2D
  ix: DocIndex
  scale: number // device px per world unit
  grids: boolean
  live: boolean
}

function paintStyle(ctx: CanvasRenderingContext2D, p: Paint, n: SceneNode): string | CanvasGradient | null {
  if (p.type === 'SOLID') return cssColor(p.color, p.opacity ?? 1)
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
    let g: CanvasGradient
    if (p.type === 'GRADIENT_LINEAR') {
      const l = gradientLine(p.angle ?? 90, n.width, n.height)
      g = ctx.createLinearGradient(l.x1, l.y1, l.x2, l.y2)
    } else g = ctx.createRadialGradient(n.width / 2, n.height / 2, 0, n.width / 2, n.height / 2, Math.max(n.width, n.height) / 2)
    for (const s of p.stops)
      g.addColorStop(Math.max(0, Math.min(1, s.position)), cssColor(s.color, (s.opacity ?? 1) * (p.opacity ?? 1)))
    return g
  }
  return null
}

/** Paint an image or video frame (`sw` × `sh` source pixels) into the node box using the paint's scale mode. Expects the clip to be set. */
function drawScaled(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, mode: 'FILL' | 'FIT' | 'STRETCH' | undefined, n: SceneNode) {
  let dw = n.width
  let dh = n.height
  if (mode !== 'STRETCH' && sw > 0 && sh > 0) {
    const s = mode === 'FIT' ? Math.min(n.width / sw, n.height / sh) : Math.max(n.width / sw, n.height / sh)
    dw = sw * s
    dh = sh * s
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, (n.width - dw) / 2, (n.height - dh) / 2, dw, dh)
}

function drawImageFill(d: DrawCtx, p: Extract<Paint, { type: 'IMAGE' }>, n: SceneNode, path: Path2D) {
  const { ctx } = d
  const img = getImage(p.url)
  ctx.save()
  ctx.clip(path)
  if (!img) {
    ctx.fillStyle = '#E5E5E5'
    ctx.fillRect(0, 0, n.width, n.height)
  } else {
    ctx.globalAlpha *= p.opacity ?? 1
    drawScaled(ctx, img, img.width, img.height, p.scaleMode, n)
  }
  ctx.restore()
}

function drawVideoFill(d: DrawCtx, p: Extract<Paint, { type: 'VIDEO' }>, n: SceneNode, path: Path2D) {
  const { ctx } = d
  const v = getVideo(p.url, d.live)
  const el = v && v.ready && !v.error && v.el.videoWidth > 0 ? v.el : null
  ctx.save()
  ctx.clip(path)
  ctx.globalAlpha *= p.opacity ?? 1
  // Until there is a frame (and for the instant a loop restarts): the poster, else a neutral placeholder.
  if (!el || el.readyState < 2) {
    const poster = p.posterUrl ? getImage(p.posterUrl) : null
    if (poster) drawScaled(ctx, poster, poster.width, poster.height, p.scaleMode, n)
    else {
      ctx.fillStyle = '#E5E5E5'
      ctx.fillRect(0, 0, n.width, n.height)
    }
  }
  if (el) drawScaled(ctx, el, el.videoWidth, el.videoHeight, p.scaleMode, n)
  ctx.restore()
}

const setSpacing = (ctx: CanvasRenderingContext2D, v: number) => ((ctx as unknown as { letterSpacing: string }).letterSpacing = v + 'px')

/**
 * Draw the text of a node. `own` = false forces `style` on every run (shadows); otherwise runs that carry
 * their own fills are drawn with them, once (on the first paint pass).
 */
function drawTextLines(d: DrawCtx, n: SceneNode, style: string | CanvasGradient, firstPass: boolean, own = true) {
  const { ctx } = d
  const t = layoutText(n, measureText, wrapWidthOf(n))
  const o = textOrigin(n, t)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  for (const line of t.lines) {
    const x0 = o.lineX(line)
    const y = o.top + line.y + line.baseline
    for (const seg of line.segs) {
      let fill = style
      const runFills = own ? seg.run?.style.fills : undefined
      if (runFills) {
        if (!firstPass) continue
        const rp = visiblePaints(runFills)[0]
        const ps = rp ? paintStyle(ctx, rp, n) : null
        if (!ps) continue
        fill = ps
      }
      const st = seg.style
      const fs = fontSizeOf(st)
      ctx.font = fontString(st)
      setSpacing(ctx, st.letterSpacing ?? 0)
      ctx.fillStyle = fill
      ctx.fillText(seg.text, x0 + seg.x, y)
      if (st.textDecoration === 'UNDERLINE' || st.textDecoration === 'STRIKETHROUGH') {
        const ly = st.textDecoration === 'UNDERLINE' ? y + fs * 0.12 : y - fs * 0.3
        ctx.fillRect(x0 + seg.x, ly, seg.width, Math.max(1, fs / 14))
      }
    }
  }
  setSpacing(ctx, 0)
}

function drawGrids(d: DrawCtx, n: SceneNode, clip: Path2D) {
  const { ctx } = d
  const grids = (n.layoutGrids ?? []).filter((g) => g.visible !== false)
  if (!grids.length) return
  ctx.save()
  ctx.clip(clip)
  for (const g of grids) {
    ctx.fillStyle = ctx.strokeStyle = cssColor(g.color ?? '#FF0000', g.opacity ?? 0.1)
    if (g.pattern === 'GRID') {
      const size = Math.max(1, g.size ?? 10)
      if (size * d.scale < 4) continue
      ctx.lineWidth = 1 / d.scale
      ctx.beginPath()
      for (let x = size; x < n.width; x += size) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, n.height)
      }
      for (let y = size; y < n.height; y += size) {
        ctx.moveTo(0, y)
        ctx.lineTo(n.width, y)
      }
      ctx.stroke()
      continue
    }
    const count = Math.max(1, Math.round(g.count ?? 5))
    const gutter = g.gutter ?? 20
    const margin = g.margin ?? 0
    const total = g.pattern === 'COLUMNS' ? n.width : n.height
    const cell = (total - margin * 2 - gutter * (count - 1)) / count
    if (cell <= 0) continue
    for (let i = 0; i < count; i++) {
      const pos = margin + i * (cell + gutter)
      if (g.pattern === 'COLUMNS') ctx.fillRect(pos, 0, cell, n.height)
      else ctx.fillRect(0, pos, n.width, cell)
    }
  }
  ctx.restore()
}

const BIG = 100000

function drawNode(d: DrawCtx, id: string) {
  const { ctx, ix } = d
  const n = ix.byId.get(id)!
  if (n.visible === false) return
  ctx.save()
  const m = localMatrix(n)
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
  ctx.globalAlpha *= n.opacity ?? 1
  if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') {
    try {
      ctx.globalCompositeOperation = n.blendMode.toLowerCase().replace(/_/g, '-') as GlobalCompositeOperation
    } catch {
      /* unsupported blend mode */
    }
  }
  const effects = (n.effects ?? []).filter((e) => e.visible !== false)
  const blur = effects.find((e) => e.type === 'LAYER_BLUR')
  if (blur && blur.type === 'LAYER_BLUR' && blur.radius > 0) ctx.filter = `blur(${(blur.radius / 2) * d.scale}px)`

  const self = paintsSelf(n)
  const fills = n.type === 'LINE' || !self ? [] : visiblePaints(n.fills)
  const strokes = !self || (n.strokeWeight ?? 1) <= 0 ? [] : visiblePaints(n.strokes)
  const isText = n.type === 'TEXT'
  const paths = isText ? null : pathsOf(ix, n)
  const rule: CanvasFillRule = fillRuleOf(n)

  // Drop shadows: draw the silhouette far off-canvas and let only its shadow land in place.
  if (fills.length || (strokes.length && !isText)) {
    for (const e of effects) {
      if (e.type !== 'DROP_SHADOW') continue
      ctx.save()
      const t = ctx.getTransform()
      ctx.setTransform(t.a, t.b, t.c, t.d, t.e - BIG, t.f)
      ctx.shadowColor = cssColor(e.color, e.opacity ?? 1)
      ctx.shadowBlur = e.blur * d.scale
      ctx.shadowOffsetX = e.x * d.scale + BIG
      ctx.shadowOffsetY = e.y * d.scale
      ctx.fillStyle = '#000'
      ctx.strokeStyle = '#000'
      if (isText) drawTextLines(d, n, '#000', true, false)
      else if (fills.length) {
        const spread = e.spread ?? 0
        const shape = spread && !isBoolean(n) ? nodeShape(n, -spread) : null
        ctx.fill(shape?.offsettable ? new Path2D(shape.d) : paths!.fill, rule)
      } else {
        ctx.lineWidth = n.strokeWeight ?? 1
        ctx.stroke(paths!.stroke)
      }
      ctx.restore()
    }
  }

  if (isText) {
    fills.forEach((p, i) => {
      const style = paintStyle(ctx, p, n)
      if (style) drawTextLines(d, n, style, i === 0)
    })
    // Runs with their own colour still show when the node itself has no fill.
    if (!fills.length && n.textRuns?.some((r) => r.style.fills)) drawTextLines(d, n, 'rgba(0,0,0,0)', true)
  } else {
    for (const p of fills) {
      if (p.type === 'IMAGE') drawImageFill(d, p, n, paths!.fill)
      else if (p.type === 'VIDEO') drawVideoFill(d, p, n, paths!.fill)
      else {
        const style = paintStyle(ctx, p, n)
        if (style) {
          ctx.fillStyle = style
          ctx.fill(paths!.fill, rule)
        }
      }
    }
    for (const e of effects) {
      if (e.type !== 'INNER_SHADOW' || !fills.length) continue
      ctx.save()
      ctx.clip(paths!.fill, rule)
      ctx.shadowColor = cssColor(e.color, e.opacity ?? 1)
      ctx.shadowBlur = e.blur * d.scale
      ctx.shadowOffsetX = e.x * d.scale
      ctx.shadowOffsetY = e.y * d.scale
      const ring = new Path2D()
      ring.rect(-BIG, -BIG, BIG * 2 + n.width, BIG * 2 + n.height)
      ring.addPath(paths!.fill)
      ctx.fillStyle = '#000'
      ctx.fill(ring, 'evenodd')
      ctx.restore()
    }
    const children = isBoolean(n) ? [] : kids(ix, id)
    if (children.length) {
      const clip = n.type === 'FRAME' && n.clipsContent !== false
      let saves = 0
      if (clip) {
        ctx.save()
        saves++
        ctx.clip(paths!.fill)
      }
      for (const c of children) {
        const cn = ix.byId.get(c)!
        if (cn.isMask && cn.visible !== false) {
          // A mask clips everything stacked above it in the same parent.
          if (cn.type !== 'TEXT') {
            ctx.save()
            saves++
            const t = ctx.getTransform()
            const lm = localMatrix(cn)
            ctx.transform(lm[0], lm[1], lm[2], lm[3], lm[4], lm[5])
            ctx.clip(pathsOf(ix, cn).fill, fillRuleOf(cn))
            ctx.setTransform(t)
          }
          continue
        }
        drawNode(d, c)
      }
      while (saves--) ctx.restore()
    }
    if (strokes.length) {
      ctx.lineWidth = n.strokeWeight ?? 1
      ctx.setLineDash(n.dashPattern ?? [])
      ctx.lineCap = n.strokeCap === 'ROUND' ? 'round' : n.strokeCap === 'SQUARE' ? 'square' : 'butt'
      ctx.lineJoin = n.strokeCap === 'ROUND' ? 'round' : 'miter'
      const heads = arrowHeads(n)
      for (const p of strokes) {
        const style = paintStyle(ctx, p, n)
        if (!style) continue
        ctx.strokeStyle = style
        ctx.stroke(paths!.stroke)
        if (heads) {
          ctx.setLineDash([])
          ctx.lineCap = ctx.lineJoin = 'round'
          ctx.stroke(new Path2D(heads))
        }
      }
      ctx.setLineDash([])
    }
    if (d.grids && n.layoutGrids?.length && n.type === 'FRAME') drawGrids(d, n, paths!.fill)
  }
  ctx.restore()
}

/** Draw document nodes. The caller sets the base transform (world → device). */
export function drawNodes(ctx: CanvasRenderingContext2D, ix: DocIndex, ids: string[], scale: number, opts: DrawOptions = {}) {
  const d: DrawCtx = { ctx, ix, scale, grids: !!opts.grids, live: !opts.still }
  for (const id of ids) drawNode(d, id)
}

// ---------- overlay ----------
const poly = (ctx: CanvasRenderingContext2D, pts: Pt[]) => {
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.closePath()
}

export function screenCorners(m: Mat, w: number, h: number, vp: Viewport): Pt[] {
  return corners(m, w, h).map((p) => ({ x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y }))
}

export interface SelectionBox {
  /** Matrix mapping box-local (0..w, 0..h) to world. */
  m: Mat
  w: number
  h: number
  single: SceneNode | null
}

export function selectionBox(st: Pick<EditorState, 'doc' | 'world' | 'selection'>): SelectionBox | null {
  const ids = st.selection.filter((id) => st.doc.byId.has(id))
  if (!ids.length) return null
  if (ids.length === 1) {
    const n = st.doc.byId.get(ids[0])!
    return { m: st.world.get(ids[0])!, w: n.width, h: n.height, single: n }
  }
  const b = boundsOf(ids.flatMap((id) => corners(st.world.get(id)!, st.doc.byId.get(id)!.width, st.doc.byId.get(id)!.height)))
  return { m: [1, 0, 0, 1, b.x, b.y], w: b.w, h: b.h, single: null }
}

export interface FrameLabel {
  id: string
  x: number
  y: number
  w: number
  angle: number
  text: string
  purple: boolean
}

/** Name labels shown above top-level frames, and above sections at any depth (screen space). */
export function frameLabels(st: Pick<EditorState, 'doc' | 'world' | 'viewport'>, ctx: CanvasRenderingContext2D): FrameLabel[] {
  const out: FrameLabel[] = []
  ctx.font = '11px Inter, sans-serif'
  const ids = [...kids(st.doc, ROOT)]
  // Nested sections, parents before children so the innermost label wins a click.
  const nested = (parent: string) => {
    for (const id of kids(st.doc, parent)) {
      const n = st.doc.byId.get(id)!
      if (n.visible === false || (n.type !== 'FRAME' && n.type !== 'GROUP')) continue
      if (n.isSection && parent !== ROOT) ids.push(id)
      if (!n.componentId && !n.booleanOp) nested(id)
    }
  }
  for (const n of st.doc.byId.values())
    if (n.isSection && n.parentId) {
      nested(ROOT)
      break
    }
  for (const id of ids) {
    const n = st.doc.byId.get(id)!
    if (n.type !== 'FRAME' || n.visible === false) continue
    const m = st.world.get(id)!
    const o = apply(m, { x: 0, y: 0 })
    const maxW = n.width * st.viewport.zoom
    if (maxW < 14) continue
    const purple = !!(n.isComponent || n.isComponentSet || n.componentId)
    let text = (n.isComponent || n.isComponentSet ? '❖ ' : n.componentId ? '◇ ' : '') + n.name
    let w = ctx.measureText(text).width
    while (w > maxW && text.length > 1) {
      text = text.slice(0, -2) + '…'
      w = ctx.measureText(text).width
    }
    out.push({
      id,
      x: o.x * st.viewport.zoom + st.viewport.x,
      y: o.y * st.viewport.zoom + st.viewport.y,
      w,
      angle: (Math.atan2(m[1], m[0]) * 180) / Math.PI,
      text,
      purple,
    })
  }
  return out
}

export interface RemoteUser {
  color: string
  selection: string[]
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString()
const worldBoxOf = (st: Pick<EditorState, 'doc' | 'world'>, id: string): Box => {
  const n = st.doc.byId.get(id)!
  return boundsOf(corners(st.world.get(id)!, n.width, n.height))
}

function pill(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, color: string) {
  ctx.font = '11px Inter, sans-serif'
  const tw = ctx.measureText(text).width + 10
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(cx - tw / 2, cy - 9, tw, 18, 4)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, cx, cy + 4)
  ctx.textAlign = 'left'
}

/** Screen position of the prototype connector handle for the current selection. */
export function protoHandle(st: EditorState): Pt | null {
  if (st.mode !== 'prototype' || st.selection.length !== 1 || st.editingId || st.vedit) return null
  const box = selectionBox(st)
  if (!box) return null
  const b = boundsOf(screenCorners(box.m, box.w, box.h, st.viewport))
  return { x: b.x + b.w, y: b.y + b.h / 2 }
}

function noodle(ctx: CanvasRenderingContext2D, a: Box, b: Box | Pt, color: string) {
  let from: Pt
  let to: Pt
  let dir: Pt
  let end: Pt
  if ('w' in b) {
    if (b.x >= a.x + a.w - 1) {
      from = { x: a.x + a.w, y: a.y + a.h / 2 }
      to = { x: b.x, y: b.y + Math.min(b.h / 2, 40) }
      dir = { x: 1, y: 0 }
      end = { x: 1, y: 0 }
    } else if (b.x + b.w <= a.x + 1) {
      from = { x: a.x, y: a.y + a.h / 2 }
      to = { x: b.x + b.w, y: b.y + Math.min(b.h / 2, 40) }
      dir = { x: -1, y: 0 }
      end = { x: -1, y: 0 }
    } else if (b.y >= a.y) {
      from = { x: a.x + a.w / 2, y: a.y + a.h }
      to = { x: b.x + b.w / 2, y: b.y }
      dir = { x: 0, y: 1 }
      end = { x: 0, y: 1 }
    } else {
      from = { x: a.x + a.w / 2, y: a.y }
      to = { x: b.x + b.w / 2, y: b.y + b.h }
      dir = { x: 0, y: -1 }
      end = { x: 0, y: -1 }
    }
  } else {
    from = { x: a.x + a.w, y: a.y + a.h / 2 }
    to = b
    dir = { x: 1, y: 0 }
    end = { x: Math.sign(to.x - from.x) || 1, y: 0 }
  }
  const k = Math.max(30, Math.hypot(to.x - from.x, to.y - from.y) * 0.4)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.bezierCurveTo(from.x + dir.x * k, from.y + dir.y * k, to.x - end.x * k, to.y - end.y * k, to.x, to.y)
  ctx.stroke()
  // Arrowhead
  const ang = Math.atan2(end.y, end.x)
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - 9 * Math.cos(ang - 0.45), to.y - 9 * Math.sin(ang - 0.45))
  ctx.lineTo(to.x - 9 * Math.cos(ang + 0.45), to.y - 9 * Math.sin(ang + 0.45))
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(from.x, from.y, 4, 0, Math.PI * 2)
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.stroke()
}

function drawPrototype(ctx: CanvasRenderingContext2D, st: EditorState) {
  const vp = st.viewport
  const sbox = (id: string): Box => {
    const b = worldBoxOf(st, id)
    return { x: b.x * vp.zoom + vp.x, y: b.y * vp.zoom + vp.y, w: b.w * vp.zoom, h: b.h * vp.zoom }
  }
  for (const n of st.doc.byId.values()) {
    if (n.flowStart) {
      const b = sbox(n.id)
      ctx.font = '11px Inter, sans-serif'
      const label = `${n.flowStart} ▶`
      const tw = ctx.measureText(label).width + 12
      ctx.fillStyle = BLUE
      ctx.beginPath()
      ctx.roundRect(b.x - tw - 8, b.y, tw, 20, 4)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(label, b.x - tw - 2, b.y + 14)
    }
    for (const r of n.reactions ?? []) {
      if (!r.destinationId || !st.doc.byId.has(r.destinationId)) continue
      noodle(ctx, sbox(n.id), sbox(r.destinationId), BLUE)
    }
  }
  if (st.protoDrag && st.doc.byId.has(st.protoDrag.from)) {
    const to = st.protoDrag.target ? sbox(st.protoDrag.target) : { x: st.protoDrag.to.x * vp.zoom + vp.x, y: st.protoDrag.to.y * vp.zoom + vp.y }
    noodle(ctx, sbox(st.protoDrag.from), to, BLUE)
  } else {
    const h = protoHandle(st)
    if (h) {
      ctx.beginPath()
      ctx.arc(h.x, h.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = BLUE
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(h.x - 4, h.y)
      ctx.lineTo(h.x + 4, h.y)
      ctx.moveTo(h.x, h.y - 4)
      ctx.lineTo(h.x, h.y + 4)
      ctx.stroke()
    }
  }
}

function drawMeasure(ctx: CanvasRenderingContext2D, st: EditorState) {
  const ids = st.selection.filter((id) => st.doc.byId.has(id))
  if (!ids.length) return
  let target = st.hover && !ids.includes(st.hover) && st.doc.byId.has(st.hover) ? st.hover : null
  if (!target && ids.length === 1) {
    const p = parentOf(st.doc, ids[0])
    if (p !== ROOT) target = p
  }
  if (!target) return
  const vp = st.viewport
  const a = unionBoxes(ids.map((id) => worldBoxOf(st, id)))
  const b = worldBoxOf(st, target)
  const sx = (v: number) => v * vp.zoom + vp.x
  const sy = (v: number) => v * vp.zoom + vp.y
  const ar = a.x + a.w
  const br = b.x + b.w
  const ab = a.y + a.h
  const bb = b.y + b.h
  const overlapY = Math.min(ab, bb) > Math.max(a.y, b.y)
  const overlapX = Math.min(ar, br) > Math.max(a.x, b.x)
  const yMid = overlapY ? (Math.max(a.y, b.y) + Math.min(ab, bb)) / 2 : a.y + a.h / 2
  const xMid = overlapX ? (Math.max(a.x, b.x) + Math.min(ar, br)) / 2 : a.x + a.w / 2
  const hs: [number, number][] = []
  const vs: [number, number][] = []
  if (ar <= b.x) hs.push([ar, b.x])
  else if (br <= a.x) hs.push([br, a.x])
  else {
    if (Math.abs(a.x - b.x) > 0.01) hs.push([Math.min(a.x, b.x), Math.max(a.x, b.x)])
    if (Math.abs(ar - br) > 0.01) hs.push([Math.min(ar, br), Math.max(ar, br)])
  }
  if (ab <= b.y) vs.push([ab, b.y])
  else if (bb <= a.y) vs.push([bb, a.y])
  else {
    if (Math.abs(a.y - b.y) > 0.01) vs.push([Math.min(a.y, b.y), Math.max(a.y, b.y)])
    if (Math.abs(ab - bb) > 0.01) vs.push([Math.min(ab, bb), Math.max(ab, bb)])
  }
  ctx.strokeStyle = RED
  ctx.lineWidth = 1
  const tm = st.world.get(target)!
  const tn = st.doc.byId.get(target)!
  poly(ctx, screenCorners(tm, tn.width, tn.height, vp))
  ctx.stroke()
  for (const [x1, x2] of hs) {
    ctx.beginPath()
    ctx.moveTo(sx(x1), Math.round(sy(yMid)) + 0.5)
    ctx.lineTo(sx(x2), Math.round(sy(yMid)) + 0.5)
    ctx.stroke()
    pill(ctx, fmt(x2 - x1), (sx(x1) + sx(x2)) / 2, sy(yMid) - 12, RED)
  }
  for (const [y1, y2] of vs) {
    ctx.beginPath()
    ctx.moveTo(Math.round(sx(xMid)) + 0.5, sy(y1))
    ctx.lineTo(Math.round(sx(xMid)) + 0.5, sy(y2))
    ctx.stroke()
    pill(ctx, fmt(y2 - y1), sx(xMid) + 22, (sy(y1) + sy(y2)) / 2, RED)
  }
}

export const RULER = 20
function drawRulers(ctx: CanvasRenderingContext2D, st: EditorState) {
  const vp = st.viewport
  const { w, h } = st.canvasSize
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000]
  const step = steps.find((s) => s * vp.zoom >= 56) ?? 50000
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, RULER)
  ctx.fillRect(0, 0, RULER, h)
  const box = selectionBox(st)
  if (box) {
    const b = boundsOf(screenCorners(box.m, box.w, box.h, vp))
    ctx.fillStyle = 'rgba(13,153,255,0.18)'
    ctx.fillRect(b.x, 0, b.w, RULER)
    ctx.fillRect(0, b.y, RULER, b.h)
  }
  ctx.strokeStyle = '#E0E0E0'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, RULER + 0.5)
  ctx.lineTo(w, RULER + 0.5)
  ctx.moveTo(RULER + 0.5, 0)
  ctx.lineTo(RULER + 0.5, h)
  ctx.stroke()
  ctx.fillStyle = '#8C8C8C'
  ctx.strokeStyle = '#BDBDBD'
  ctx.font = '9px Inter, sans-serif'
  ctx.textAlign = 'left'
  ctx.beginPath()
  const x0 = Math.floor(-vp.x / vp.zoom / step) * step
  for (let x = x0; x * vp.zoom + vp.x < w; x += step) {
    const s = Math.round(x * vp.zoom + vp.x) + 0.5
    if (s < RULER) continue
    ctx.moveTo(s, RULER - 5)
    ctx.lineTo(s, RULER)
    ctx.fillText(String(x), s + 3, 10)
  }
  const y0 = Math.floor(-vp.y / vp.zoom / step) * step
  for (let y = y0; y * vp.zoom + vp.y < h; y += step) {
    const s = Math.round(y * vp.zoom + vp.y) + 0.5
    if (s < RULER) continue
    ctx.moveTo(RULER - 5, s)
    ctx.lineTo(RULER, s)
    ctx.save()
    ctx.translate(10, s + 3)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'right'
    ctx.fillText(String(y), 0, 0)
    ctx.restore()
  }
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, RULER, RULER)
}

function drawVectorEdit(ctx: CanvasRenderingContext2D, st: EditorState) {
  const n = st.doc.byId.get(st.vedit!.id)
  const m = st.world.get(st.vedit!.id)
  if (!n || !m || n.type !== 'VECTOR') return
  const vp = st.viewport
  const sc = (x: number, y: number): Pt => {
    const p = apply(m, { x, y })
    return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y }
  }
  const subs = editSubs(n)
  ctx.strokeStyle = BLUE
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const s of subs) {
    const first = sc(s.pts[0].x, s.pts[0].y)
    ctx.moveTo(first.x, first.y)
    for (const [ai, bi] of segmentsOf(s)) {
      const a = s.pts[ai]
      const b = s.pts[bi]
      const c1 = sc(a.ox, a.oy)
      const c2 = sc(b.ix, b.iy)
      const e = sc(b.x, b.y)
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y)
    }
  }
  ctx.stroke()
  const sel = new Set(st.vedit!.sel)
  let idx = 0
  for (const s of subs)
    for (const p of s.pts) {
      const a = sc(p.x, p.y)
      const on = sel.has(idx++)
      if (on) {
        for (const [hx, hy] of [
          [p.ix, p.iy],
          [p.ox, p.oy],
        ]) {
          if (hx === p.x && hy === p.y) continue
          const hpt = sc(hx, hy)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(hpt.x, hpt.y)
          ctx.stroke()
          ctx.save()
          ctx.translate(hpt.x, hpt.y)
          ctx.rotate(Math.PI / 4)
          ctx.fillStyle = '#fff'
          ctx.fillRect(-3, -3, 6, 6)
          ctx.strokeRect(-3, -3, 6, 6)
          ctx.restore()
        }
      }
      ctx.beginPath()
      ctx.arc(a.x, a.y, on ? 4.5 : 3.5, 0, Math.PI * 2)
      ctx.fillStyle = on ? BLUE : '#fff'
      ctx.fill()
      ctx.strokeStyle = on ? '#fff' : BLUE
      ctx.stroke()
      ctx.strokeStyle = BLUE
    }
}

function drawTextEdit(ctx: CanvasRenderingContext2D, st: EditorState) {
  const n = st.doc.byId.get(st.editingId!)
  const m = st.world.get(st.editingId!)
  if (!n || !m || !st.textSel) return
  const vp = st.viewport
  ctx.save()
  ctx.translate(vp.x, vp.y)
  ctx.scale(vp.zoom, vp.zoom)
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
  const t = layoutText(n, measureText, wrapWidthOf(n))
  const a = Math.min(st.textSel.start, st.textSel.end)
  const b = Math.max(st.textSel.start, st.textSel.end)
  if (b > a) {
    ctx.fillStyle = 'rgba(13,153,255,0.3)'
    for (const r of selectionRects(n, t, measureText, a, b)) ctx.fillRect(r.x, r.y, r.w, r.h)
  } else if (st.caretOn) {
    const c = caretRect(n, t, measureText, a)
    const w = 1.25 / vp.zoom
    ctx.fillStyle = '#000'
    ctx.fillRect(c.x - w / 2, c.y, w, c.h)
  }
  ctx.restore()
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: EditorState, remotes: RemoteUser[]) {
  const vp = st.viewport
  const { doc, world } = st
  const outline = (id: string, color: string, width: number) => {
    const n = doc.byId.get(id)
    const m = world.get(id)
    if (!n || !m) return
    ctx.strokeStyle = color
    ctx.lineWidth = width
    poly(ctx, screenCorners(m, n.width, n.height, vp))
    ctx.stroke()
  }
  const colorOf = (id: string) => {
    const n = doc.byId.get(id)
    return n && (n.isComponent || n.isComponentSet || n.componentId || n.sourceId) ? PURPLE : BLUE
  }

  // Frame labels
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  for (const l of frameLabels(st, ctx)) {
    ctx.save()
    ctx.translate(l.x, l.y)
    ctx.rotate((l.angle * Math.PI) / 180)
    const active = st.selection.includes(l.id) || st.hover === l.id
    ctx.fillStyle = l.purple ? PURPLE : active ? BLUE : 'rgba(0,0,0,0.5)'
    ctx.fillText(l.text, 0, -6)
    ctx.restore()
  }

  for (const r of remotes) for (const id of r.selection) outline(id, r.color, 1.5)

  if (st.mode === 'prototype') drawPrototype(ctx, st)

  if (st.dropTarget) outline(st.dropTarget, BLUE, 2)
  if (st.hover && !st.selection.includes(st.hover) && st.tool === 'move' && !st.vedit) outline(st.hover, colorOf(st.hover), 2)

  // Selection
  const box = selectionBox(st)
  if (st.vedit) drawVectorEdit(ctx, st)
  else if (box && !st.editingId) {
    const color = st.selection.length === 1 ? colorOf(st.selection[0]) : BLUE
    if (st.selection.length > 1) for (const id of st.selection) outline(id, colorOf(id), 1)
    const pts = screenCorners(box.m, box.w, box.h, vp)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    poly(ctx, pts)
    ctx.stroke()
    if (st.tool === 'move') {
      ctx.fillStyle = '#fff'
      const angle = Math.atan2(box.m[1], box.m[0])
      const isLine = box.single?.type === 'LINE'
      for (const p of isLine ? [pts[0], pts[1]] : pts) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(angle)
        ctx.fillRect(-4, -4, 8, 8)
        ctx.strokeRect(-3.5, -3.5, 7, 7)
        ctx.restore()
      }
    }
    const b = boundsOf(pts)
    pill(ctx, `${fmt(box.w)} × ${fmt(box.h)}`, b.x + b.w / 2, b.y + b.h + 17, color)
  } else if (box && st.editingId) {
    ctx.strokeStyle = BLUE
    ctx.lineWidth = 1
    poly(ctx, screenCorners(box.m, box.w, box.h, vp))
    ctx.stroke()
    drawTextEdit(ctx, st)
  }

  if (st.altDown && !st.editingId && !st.vedit && !Object.keys(st.draft).length) drawMeasure(ctx, st)

  // Snap guides
  if (st.guides.length) {
    ctx.strokeStyle = RED
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const g of st.guides) {
      ctx.moveTo(Math.round(g.x1 * vp.zoom + vp.x) + 0.5, Math.round(g.y1 * vp.zoom + vp.y) + 0.5)
      ctx.lineTo(Math.round(g.x2 * vp.zoom + vp.x) + 0.5, Math.round(g.y2 * vp.zoom + vp.y) + 0.5)
    }
    ctx.stroke()
  }

  if (st.marquee) {
    const mq = st.marquee
    const x = mq.x * vp.zoom + vp.x
    const y = mq.y * vp.zoom + vp.y
    ctx.fillStyle = 'rgba(13,153,255,0.1)'
    ctx.strokeStyle = BLUE
    ctx.lineWidth = 1
    ctx.fillRect(x, y, mq.w * vp.zoom, mq.h * vp.zoom)
    ctx.strokeRect(x + 0.5, y + 0.5, mq.w * vp.zoom, mq.h * vp.zoom)
  }

  // Pencil preview
  if (st.pencil && st.pencil.length > 1) {
    ctx.strokeStyle = '#000'
    ctx.lineWidth = Math.max(1, vp.zoom)
    ctx.lineJoin = ctx.lineCap = 'round'
    ctx.beginPath()
    st.pencil.forEach((p, i) => {
      const x = p.x * vp.zoom + vp.x
      const y = p.y * vp.zoom + vp.y
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    ctx.lineJoin = 'miter'
    ctx.lineCap = 'butt'
  }

  // Pen preview
  if (st.pen) {
    const pts = st.pen.points
    const sc = (p: Pt) => ({ x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y })
    ctx.strokeStyle = BLUE
    ctx.lineWidth = 1.5
    ctx.beginPath()
    pts.forEach((p, i) => {
      const s = sc(p)
      if (!i) return ctx.moveTo(s.x, s.y)
      const prev = pts[i - 1]
      const c1 = sc({ x: prev.x + prev.hx, y: prev.y + prev.hy })
      const c2 = sc({ x: p.x - p.hx, y: p.y - p.hy })
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, s.x, s.y)
    })
    if (st.pen.cursor && pts.length) {
      const last = pts[pts.length - 1]
      const c1 = sc({ x: last.x + last.hx, y: last.y + last.hy })
      const c = sc(st.pen.cursor)
      ctx.bezierCurveTo(c1.x, c1.y, c.x, c.y, c.x, c.y)
    }
    ctx.stroke()
    for (const p of pts) {
      const s = sc(p)
      if (p.hx || p.hy) {
        const a = sc({ x: p.x + p.hx, y: p.y + p.hy })
        const b = sc({ x: p.x - p.hx, y: p.y - p.hy })
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        for (const h of [a, b]) {
          ctx.beginPath()
          ctx.arc(h.x, h.y, 3, 0, Math.PI * 2)
          ctx.fillStyle = BLUE
          ctx.fill()
        }
      }
      ctx.fillStyle = '#fff'
      ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7)
      ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7)
    }
  }

  if (st.showRulers) drawRulers(ctx, st)
}

export function visibleRootIds(st: Pick<EditorState, 'doc' | 'world' | 'viewport' | 'canvasSize'>): string[] {
  const vp = st.viewport
  const view: Box = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: st.canvasSize.w / vp.zoom, h: st.canvasSize.h / vp.zoom }
  return kids(st.doc, ROOT).filter((id) => {
    const n = st.doc.byId.get(id)!
    // Unclipped content and shadows may extend past the box, so cull conservatively.
    if (n.type === 'GROUP' || (n.type === 'FRAME' && n.clipsContent === false)) return true
    const b = boundsOf(corners(st.world.get(id)!, n.width, n.height))
    const pad = 200 + (n.strokeWeight ?? 0)
    return boxesIntersect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, view)
  })
}

/** Render nodes to an offscreen canvas (PNG/JPG export, thumbnails). */
export function renderToCanvas(ix: DocIndex, ids: string[], bounds: Box, scale: number, background?: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bounds.w * scale))
  canvas.height = Math.max(1, Math.round(bounds.h * scale))
  const ctx = canvas.getContext('2d')!
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  for (const id of ids) {
    const p = parentOf(ix, id)
    ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale)
    if (p !== ROOT) {
      const m = worldMatrix(ix, p)
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    }
    drawNodes(ctx, ix, [id], scale, { still: true })
  }
  return canvas
}
