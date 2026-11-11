// Prototype presentation view: plays the interactions defined in the editor's Prototype tab.
import { useQuery } from 'convex/react'
import { ChevronLeft, ChevronRight, Maximize, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { buildIndex, descendants, screenFrames, type DocIndex } from '../shared/doc'
import { runLayout } from '../shared/layout'
import type { PrototypeDevice, Reaction, SceneNode } from '../shared/types'
import { ensureFont, measureText, onFontsChanged } from './editor/fonts'
import { hitPath } from './editor/hit'
import { drawNodes, setImageLoadCallback, toggleVideo, videosPlayingSince } from './editor/render'
import { usePageNodes } from './usePageNodes'
import { frameView, overlayOrigin, scrollBy, type FrameView, type Scroll } from './playerView'

interface Doc {
  ix: DocIndex
  frames: string[]
}
interface Anim {
  from: string
  to: string
  fromScroll: Scroll
  transition: NonNullable<Reaction['transition']>
  direction: NonNullable<Reaction['direction']>
  easing: NonNullable<Reaction['easing']>
  duration: number
  t0: number
}
interface Screen {
  id: string
  via?: Reaction
  scroll: Scroll
}
interface Overlay extends Screen {
  t0: number
  hover?: string
}
interface State {
  stack: Screen[]
  overlays: Overlay[]
  anim: Anim | null
  hover: string | null
  flash: number
}
/** Where a frame is drawn: its view, the screen position of its top-left corner and the scale. */
interface Placed {
  v: FrameView
  x: number
  y: number
  s: number
}
interface Drag {
  x: number
  y: number
  moved: boolean
  path: string[] | null
  layer: 'screen' | 'overlay'
}

const ease = (t: number, e: string) => (e === 'LINEAR' ? t : e === 'EASE_IN' ? t * t : e === 'EASE_IN_OUT' ? t * t * (3 - 2 * t) : 1 - (1 - t) * (1 - t))
const OPPOSITE = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as const
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** A press that moves further than this (px) scrolls instead of clicking. */
const DRAG_SLOP = 6
const BAR = 48

function mixColor(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return '#' + [0, 1, 2].map((i) => Math.round(lerp(p(a, i), p(b, i), t)).toString(16).padStart(2, '0')).join('')
}

/** Destination frame with layers that also exist (by name) in the source frame interpolated from their old state. */
function smartIndex(src: DocIndex, fromId: string, dst: DocIndex, toId: string, t: number): DocIndex {
  const key = (ix: DocIndex, root: string, id: string) => {
    const parts: string[] = []
    let cur = ix.byId.get(id)
    while (cur && cur.id !== root) {
      parts.push(cur.type + ':' + cur.name)
      cur = cur.parentId ? ix.byId.get(cur.parentId) : undefined
    }
    return parts.join('/')
  }
  const before = new Map<string, SceneNode>()
  for (const id of descendants(src, fromId)) {
    const k = key(src, fromId, id)
    if (!before.has(k)) before.set(k, src.byId.get(id)!)
  }
  const to = dst.byId.get(toId)!
  const out: SceneNode[] = [to]
  for (const id of descendants(dst, toId)) {
    const b = dst.byId.get(id)!
    const a = before.get(key(dst, toId, id))
    if (!a) {
      out.push({ ...b, opacity: (b.opacity ?? 1) * t })
      continue
    }
    const n: SceneNode = {
      ...b,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      width: lerp(a.width, b.width, t),
      height: lerp(a.height, b.height, t),
      rotation: lerp(a.rotation ?? 0, b.rotation ?? 0, t),
      opacity: lerp(a.opacity ?? 1, b.opacity ?? 1, t),
    }
    if (a.cornerRadius != null || b.cornerRadius != null) n.cornerRadius = lerp(a.cornerRadius ?? 0, b.cornerRadius ?? 0, t)
    const fa = a.fills?.[0]
    const fb = b.fills?.[0]
    if (a.fills?.length === 1 && b.fills?.length === 1 && fa?.type === 'SOLID' && fb?.type === 'SOLID' && fa.color.length === 7 && fb.color.length === 7)
      n.fills = [{ ...fb, color: mixColor(fa.color, fb.color, t), opacity: lerp(fa.opacity ?? 1, fb.opacity ?? 1, t) }]
    if (b.type === 'TEXT' && a.fontSize != null && b.fontSize != null) n.fontSize = lerp(a.fontSize, b.fontSize, t)
    out.push(n)
  }
  return buildIndex(out)
}

export function Player({ fileId, pageId, frameId }: { fileId: Id<'files'>; pageId?: string; frameId?: string }) {
  const file = useQuery(api.files.get, { fileId })
  const pages = useQuery(api.pages.list, file ? { fileId } : 'skip')
  const page = pages?.find((p) => p._id === pageId) ?? pages?.[0]
  const stored = usePageNodes(page?._id)
  const device = (page as { prototypeDevice?: PrototypeDevice } | undefined)?.prototypeDevice ?? null
  const [tick, setTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useRef<State>({ stack: [], overlays: [], anim: null, hover: null, flash: 0 })
  const [current, setCurrent] = useState<string | null>(null)
  const redraw = useRef<() => void>(() => {})
  const drag = useRef<Drag | null>(null)
  const swallowClick = useRef(false)

  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const a = onFontsChanged(bump)
    // Images and video frames do not change the layout: repainting is enough.
    const b = setImageLoadCallback(() => redraw.current())
    return () => {
      a()
      b()
    }
  }, [])

  const doc: Doc | null = useMemo(() => {
    if (!stored) return null
    for (const n of stored) if (n.type === 'TEXT') ensureFont(n.fontFamily ?? 'Inter', n.fontWeight ?? 400, !!n.italic)
    const res = runLayout(stored, measureText)
    // Screens are the top-level frames; sections only group them.
    const frames = screenFrames(res.index).filter((id) => res.index.byId.get(id)!.visible !== false)
    return { ix: res.index, frames }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, tick])
  const docRef = useRef(doc)
  docRef.current = doc
  const deviceRef = useRef(device)
  deviceRef.current = device

  // Views are rebuilt only when the document, the device or a frame's scroll offsets change.
  const views = useRef(new Map<string, { doc: Doc; device: PrototypeDevice | null; scroll: Scroll; v: FrameView }>())
  const viewOf = (id: string, scroll: Scroll): FrameView => {
    const d = docRef.current!
    const hit = views.current.get(id)
    if (hit && hit.doc === d && hit.device === deviceRef.current && hit.scroll === scroll) return hit.v
    const v = frameView(d.ix, id, deviceRef.current, scroll)
    views.current.set(id, { doc: d, device: deviceRef.current, scroll, v })
    return v
  }

  const startId = useMemo(() => {
    if (!doc) return null
    if (frameId && doc.frames.includes(frameId)) return frameId
    return doc.frames.find((id) => doc.ix.byId.get(id)!.flowStart) ?? doc.frames[0] ?? null
  }, [doc, frameId])

  // (Re)start when the starting frame becomes known or disappears.
  useEffect(() => {
    const st = state.current
    const cur = st.stack[st.stack.length - 1]?.id
    if (startId && (!cur || !docRef.current?.ix.byId.has(cur))) {
      st.stack = [{ id: startId, scroll: {} }]
      st.overlays = []
      st.anim = null
      setCurrent(startId)
    }
    redraw.current()
  }, [startId, doc])

  useEffect(() => redraw.current(), [device])

  useEffect(() => {
    document.title = file ? `${file.name} – Prototype` : 'Prototype'
  }, [file?.name])

  // ---------- geometry ----------
  const topScreen = () => state.current.stack[state.current.stack.length - 1] ?? null
  const top = () => topScreen()?.id ?? null
  const topOverlay = () => state.current.overlays[state.current.overlays.length - 1] ?? null

  /** The current screen, scaled down (never up) to fit the window above the bar and centred. */
  const stage = (): Placed => {
    const cur = topScreen()!
    const v = viewOf(cur.id, cur.scroll)
    const vw = window.innerWidth
    const vh = window.innerHeight - BAR
    const s = Math.min(1, vw / v.width, vh / v.height)
    return { v, s, x: (vw - v.width * s) / 2, y: (vh - v.height * s) / 2 }
  }
  /** Another screen (the one a transition leaves), fitted and centred on its own, as it was shown. */
  const placeScreen = (id: string, scroll: Scroll): Placed => {
    const v = viewOf(id, scroll)
    const vw = window.innerWidth
    const vh = window.innerHeight - BAR
    const s = Math.min(1, vw / v.width, vh / v.height)
    return { v, s, x: (vw - v.width * s) / 2, y: (vh - v.height * s) / 2 }
  }
  /** An overlay at its overlay position on the current screen. */
  const placeOverlay = (o: Overlay): Placed => {
    const st = stage()
    const v = viewOf(o.id, o.scroll)
    const f = docRef.current!.ix.byId.get(o.id)!
    const at = overlayOrigin(f.overlayPositionType, { x: st.x, y: st.y, w: st.v.width * st.s, h: st.v.height * st.s }, v.width * st.s, v.height * st.s)
    return { v, s: st.s, ...at }
  }

  // ---------- actions ----------
  const go = (to: string, r?: Reaction, back = false) => {
    const st = state.current
    const d = docRef.current
    const from = topScreen()
    if (!d || !from || !d.ix.byId.has(to) || st.anim) return
    const hadOverlay = st.overlays.length > 0
    st.overlays = []
    if (from.id === to && !back) {
      // Navigating to the screen already shown (a tab bar on its own tab, a sheet's Done) only closes overlays.
      if (hadOverlay) redraw.current()
      return
    }
    const transition = r?.transition ?? 'INSTANT'
    if (back) st.stack.pop()
    else st.stack.push({ id: to, via: r, scroll: {} })
    if (transition !== 'INSTANT')
      st.anim = {
        from: from.id,
        to,
        fromScroll: from.scroll,
        transition,
        direction: back ? OPPOSITE[r?.direction ?? 'LEFT'] : (r?.direction ?? 'LEFT'),
        easing: r?.easing ?? 'EASE_OUT',
        duration: Math.max(1, r?.duration ?? 300),
        t0: performance.now(),
      }
    setCurrent(to)
    redraw.current()
  }

  const run = (r: Reaction, sourceId?: string) => {
    const st = state.current
    const d = docRef.current
    if (!d) return
    switch (r.action) {
      case 'NAVIGATE':
        if (r.destinationId) go(r.destinationId, r)
        break
      case 'OVERLAY':
        if (r.destinationId && d.ix.byId.has(r.destinationId) && !st.overlays.some((o) => o.id === r.destinationId)) {
          st.overlays.push({ id: r.destinationId, via: r, scroll: {}, t0: performance.now(), hover: r.trigger === 'ON_HOVER' ? sourceId : undefined })
          redraw.current()
        }
        break
      case 'CLOSE_OVERLAY':
        st.overlays.pop()
        redraw.current()
        break
      case 'BACK':
        if (st.overlays.length) st.overlays.pop()
        else if (st.stack.length > 1) {
          const cur = st.stack[st.stack.length - 1]
          return go(st.stack[st.stack.length - 2].id, cur.via, true)
        }
        redraw.current()
        break
      case 'URL':
        if (r.url) window.open(/^https?:/.test(r.url) ? r.url : 'https://' + r.url, '_blank', 'noopener')
        break
    }
  }

  const step = (dir: 1 | -1) => {
    const d = docRef.current
    const cur = top()
    if (!d || !cur) return
    const i = d.frames.indexOf(cur)
    const next = d.frames[i + dir]
    if (next) go(next)
  }
  const restart = () => {
    const st = state.current
    if (!startId) return
    st.stack = [{ id: startId, scroll: {} }]
    st.overlays = []
    st.anim = null
    setCurrent(startId)
    redraw.current()
  }

  /** Nodes under a screen point inside a placed frame, deepest first, ending with the frame itself; null when outside it. */
  const pathIn = (p: Placed, cx: number, cy: number): string[] | null => {
    const lx = (cx - p.x) / p.s
    const ly = (cy - p.y) / p.s
    if (lx < 0 || ly < 0 || lx > p.v.width || ly > p.v.height) return null
    const path = hitPath({ doc: p.v.ix, world: p.v.world, viewport: { x: 0, y: 0, zoom: p.s } }, { x: lx, y: ly }, undefined, p.v.id)
    return [...path.reverse(), p.v.id]
  }
  /** What is under the pointer: the top overlay if there is one, else the screen. */
  const pointed = (cx: number, cy: number): { placed: Placed; path: string[] | null; layer: 'screen' | 'overlay' } | null => {
    if (!docRef.current || !topScreen()) return null
    const over = topOverlay()
    if (over && docRef.current.ix.byId.has(over.id)) {
      const placed = placeOverlay(over)
      return { placed, path: pathIn(placed, cx, cy), layer: 'overlay' }
    }
    const placed = stage()
    return { placed, path: pathIn(placed, cx, cy), layer: 'screen' }
  }
  const reactionAt = (cx: number, cy: number, triggers: Reaction['trigger'][]): { r: Reaction; id: string } | 'outside' | null => {
    const hit = pointed(cx, cy)
    if (!hit) return null
    if (!hit.path) return hit.layer === 'overlay' ? 'outside' : null
    for (const id of hit.path) {
      const r = hit.placed.v.ix.byId.get(id)?.reactions?.find((x) => triggers.includes(x.trigger))
      if (r) return { r, id }
    }
    return null
  }
  /** The video under the pointer that a click would start or pause: the topmost layer with a video fill, unless a layer above it reacts to clicks. */
  const videoAt = (cx: number, cy: number): string | null => {
    const hit = pointed(cx, cy)
    for (const id of hit?.path ?? []) {
      const n = hit!.placed.v.ix.byId.get(id)
      if (n?.reactions?.some((x) => x.trigger === 'ON_CLICK' || x.trigger === 'ON_PRESS')) return null
      const fill = (n?.fills ?? []).find((p) => p.type === 'VIDEO' && p.visible !== false && p.url)
      if (fill && fill.type === 'VIDEO') return fill.url
    }
    return null
  }
  /** Scroll whatever is under the pointer; returns the frame that moved, or null. */
  const scrollAt = (layer: 'screen' | 'overlay', path: string[], dx: number, dy: number): string | null => {
    const st = state.current
    const owner: Screen | null = layer === 'overlay' ? topOverlay() : topScreen()
    if (!owner || st.anim) return null
    const next = scrollBy(viewOf(owner.id, owner.scroll), owner.scroll, path, dx, dy)
    if (!next) return null
    const movedId = Object.keys(next).find((k) => next[k] !== owner.scroll[k]) ?? null
    owner.scroll = next
    redraw.current()
    return movedId
  }

  const slides = (o: Overlay) => o.via?.transition === 'MOVE_IN' || o.via?.transition === 'SLIDE_IN' || o.via?.transition === 'PUSH'
  const overlayDuration = (o: Overlay) => (slides(o) ? Math.max(1, o.via?.duration ?? 300) : 180)
  /** True while an overlay is still sliding or fading in: where it is drawn is not yet where it is hit-tested. */
  const overlayMoving = () => state.current.overlays.some((o) => performance.now() - o.t0 < overlayDuration(o))

  // ---------- drawing ----------
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const draw = () => {
      raf = 0
      const t0 = performance.now()
      const d = docRef.current
      const st = state.current
      const dpr = window.devicePixelRatio || 1
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
        canvas.width = Math.round(vw * dpr)
        canvas.height = Math.round(vh * dpr)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#1E1E1E'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const cur = topScreen()
      if (!d || !cur || !d.ix.byId.has(cur.id)) return
      let again = false
      const box = stage()
      const stageRect = () => ctx.rect(box.x * dpr, box.y * dpr, box.v.width * box.s * dpr, box.v.height * box.s * dpr)
      const paint = (p: Placed, ix: DocIndex, alpha: number, ox = 0, oy = 0, clip = false) => {
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        // Keep sliding screens, and everything drawn during a transition, inside the stage of the current frame.
        if (ox || oy || clip) {
          ctx.beginPath()
          stageRect()
          ctx.clip()
        }
        ctx.globalAlpha = alpha
        const k = p.s * dpr
        ctx.setTransform(k, 0, 0, k, (p.x + ox) * dpr, (p.y + oy) * dpr)
        drawNodes(ctx, ix, [p.v.id], k)
        ctx.restore()
      }
      const a = st.anim
      if (a && d.ix.byId.has(a.from) && d.ix.byId.has(a.to)) {
        const raw = Math.min(1, (performance.now() - a.t0) / a.duration)
        const e = ease(raw, a.easing)
        const from = placeScreen(a.from, a.fromScroll)
        const to = box
        const w = to.v.width * to.s
        const h = to.v.height * to.s
        const vx = a.direction === 'LEFT' ? w : a.direction === 'RIGHT' ? -w : 0
        const vy = a.direction === 'TOP' ? h : a.direction === 'BOTTOM' ? -h : 0
        switch (a.transition) {
          case 'DISSOLVE':
            paint(from, from.v.ix, 1, 0, 0, true)
            paint(to, to.v.ix, e)
            break
          case 'MOVE_IN':
            paint(from, from.v.ix, 1, 0, 0, true)
            paint(to, to.v.ix, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'PUSH':
            paint(from, from.v.ix, 1, -vx * e, -vy * e)
            paint(to, to.v.ix, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'SLIDE_IN':
            paint(from, from.v.ix, 1 - 0.4 * e, -vx * e * 0.3, -vy * e * 0.3)
            paint(to, to.v.ix, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'SMART_ANIMATE':
            paint(from, from.v.ix, 1, 0, 0, true)
            paint(to, smartIndex(from.v.ix, a.from, to.v.ix, a.to, e), Math.min(1, e * 3))
            break
          default:
            paint(to, to.v.ix, 1)
        }
        if (raw >= 1) st.anim = null
        again = true
      } else {
        st.anim = null
        paint(box, box.v.ix, 1)
      }
      for (const o of st.overlays) {
        if (!d.ix.byId.has(o.id)) continue
        const f = d.ix.byId.get(o.id)!
        const r = o.via
        const moves = slides(o)
        const dur = overlayDuration(o)
        const raw = Math.min(1, (performance.now() - o.t0) / dur)
        const t = moves ? ease(raw, r?.easing ?? 'EASE_OUT') : raw
        if (raw < 1) again = true
        // What is drawn behind the overlay: a 30 % black scrim unless the frame says otherwise.
        const bg = f.overlayBackground ?? { type: 'SOLID_COLOR', color: '#000000', opacity: 0.3 }
        if (bg.type === 'SOLID_COLOR') {
          ctx.save()
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.globalAlpha = (bg.opacity ?? 1) * Math.min(1, raw * 1.5)
          ctx.fillStyle = bg.color
          ctx.beginPath()
          stageRect()
          ctx.fill()
          ctx.restore()
        }
        const p = placeOverlay(o)
        const w = p.v.width * p.s
        const h = p.v.height * p.s
        const dir = r?.direction ?? 'TOP'
        const ox = moves ? (dir === 'LEFT' ? w : dir === 'RIGHT' ? -w : 0) * (1 - t) : 0
        const oy = moves ? (dir === 'TOP' ? h : dir === 'BOTTOM' ? -h : 0) * (1 - t) : 0
        paint(p, p.v.ix, moves ? 1 : t, ox, oy)
      }
      // Hotspot hints after a click that hit nothing.
      const flashAge = performance.now() - st.flash
      if (flashAge < 450) {
        again = true
        const over = topOverlay()
        const host = over && d.ix.byId.has(over.id) ? placeOverlay(over) : box
        ctx.save()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.beginPath()
        ctx.rect(host.x, host.y, host.v.width * host.s, host.v.height * host.s)
        ctx.clip()
        ctx.fillStyle = `rgba(13,153,255,${0.35 * (1 - flashAge / 450)})`
        for (const id of descendants(host.v.ix, host.v.id)) {
          const n = host.v.ix.byId.get(id)!
          if (!n.reactions?.some((r) => r.trigger === 'ON_CLICK' || r.trigger === 'ON_PRESS')) continue
          const m = host.v.world.get(id)!
          ctx.fillRect(host.x + m[4] * host.s, host.y + m[5] * host.s, n.width * host.s, n.height * host.s)
        }
        ctx.restore()
      }
      // Video fills: keep painting while a video that was just drawn is playing.
      if (videosPlayingSince(t0)) again = true
      if (again) raf = requestAnimationFrame(draw)
    }
    redraw.current = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const onResize = () => redraw.current()
    window.addEventListener('resize', onResize)
    // Wheel and trackpad scrolling; not passive, so the page itself never scrolls or zooms instead.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const hit = pointed(e.clientX, e.clientY)
      if (!hit?.path) return
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k
      const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k
      scrollAt(hit.layer, hit.path, dx / hit.placed.s, dy / hit.placed.s)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    redraw.current()
    return () => {
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
      videosPlayingSince(Infinity) // pause and release every video
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Delayed interactions of the current frame.
  useEffect(() => {
    const d = docRef.current
    if (!d || !current) return
    const timers = (d.ix.byId.get(current)?.reactions ?? []).filter((r) => r.trigger === 'AFTER_TIMEOUT').map((r) => setTimeout(() => top() === current && run(r, current), r.timeout ?? 800))
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, !!doc])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key.toLowerCase() === 'r') restart()
      else if (e.key.toLowerCase() === 'f') void document.documentElement.requestFullscreen?.()
      else if (e.key === 'Escape' && state.current.overlays.length) {
        state.current.overlays.pop()
        redraw.current()
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startId])

  // Dragging (a finger, or the mouse) scrolls; a press that barely moves stays a click.
  const onPointerDown = (e: React.PointerEvent) => {
    swallowClick.current = false
    if (e.button !== 0) return
    const hit = pointed(e.clientX, e.clientY)
    drag.current = { x: e.clientX, y: e.clientY, moved: false, path: hit?.path ?? null, layer: hit?.layer ?? 'screen' }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current
    if (g && e.buttons & 1) {
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
      if (!g.moved) {
        g.moved = true
        canvasRef.current!.setPointerCapture(e.pointerId)
      }
      g.x = e.clientX
      g.y = e.clientY
      const s = stage().s
      // The frame that takes the first movement keeps the gesture, so a carousel reaching its end doesn't hand it to the page.
      if (g.path) {
        const movedId = scrollAt(g.layer, g.path, -dx / s, -dy / s)
        if (movedId && g.path.length > 1) g.path = [movedId]
      }
      return
    }
    onHover(e)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = drag.current
    drag.current = null
    if (!g?.moved) return
    if (canvasRef.current!.hasPointerCapture(e.pointerId)) canvasRef.current!.releasePointerCapture(e.pointerId)
    // The click a browser may send after a drag is not a tap. It comes right away if at all, so the flag never outlives it.
    if (e.type === 'pointerup') {
      swallowClick.current = true
      setTimeout(() => (swallowClick.current = false), 0)
    }
  }

  const onClick = (e: React.MouseEvent) => {
    const st = state.current
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    if (st.anim || overlayMoving()) return
    const video = videoAt(e.clientX, e.clientY)
    if (video) return toggleVideo(video)
    const hit = reactionAt(e.clientX, e.clientY, ['ON_CLICK', 'ON_PRESS'])
    if (hit === 'outside') {
      const over = topOverlay()
      const f = over ? docRef.current?.ix.byId.get(over.id) : undefined
      if (f?.overlayBackgroundInteraction === 'NONE') return
      st.overlays.pop()
      return redraw.current()
    }
    if (hit) return run(hit.r, hit.id)
    st.flash = performance.now()
    redraw.current()
  }
  const onHover = (e: React.PointerEvent) => {
    const st = state.current
    const click = reactionAt(e.clientX, e.clientY, ['ON_CLICK', 'ON_PRESS'])
    canvasRef.current!.style.cursor = (click && click !== 'outside') || videoAt(e.clientX, e.clientY) ? 'pointer' : 'default'
    const hov = reactionAt(e.clientX, e.clientY, ['ON_HOVER'])
    const id = hov && hov !== 'outside' ? hov.id : null
    if (id === st.hover) return
    // Leaving the layer that opened a hover overlay closes it (unless the pointer moved onto the overlay itself).
    const overHoverOverlay = st.overlays.some((o) => o.hover && pathIn(placeOverlay(o), e.clientX, e.clientY))
    if (st.hover && !overHoverOverlay) {
      const before = st.overlays.length
      st.overlays = st.overlays.filter((o) => o.hover !== st.hover)
      if (st.overlays.length !== before) redraw.current()
    }
    if (!overHoverOverlay) st.hover = id
    if (hov && hov !== 'outside' && id && !st.anim) run(hov.r, hov.id)
  }

  if (file === null)
    return (
      <div className="player">
        <div className="player-empty">
          <span>
            This prototype does not exist, or you do not have access to it. <a href="#/">Sign in</a>
          </span>
        </div>
      </div>
    )
  const index = doc && current ? doc.frames.indexOf(current) : -1
  const name = doc && current ? doc.ix.byId.get(current)?.name : ''
  return (
    <div className="player">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
      />
      {stored && !doc?.frames.length && <div className="player-empty">This page has no frames to present.</div>}
      <div className="player-bar">
        <a className="player-btn" href={`#/file/${fileId}`} title="Back to the editor">
          <X size={16} />
        </a>
        <span className="player-title">{file?.name}</span>
        <span className="grow" />
        <button className="player-btn" title="Previous frame (←)" disabled={index <= 0} onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </button>
        <span className="player-count">
          {name} · {index + 1} / {doc?.frames.length ?? 0}
        </span>
        <button className="player-btn" title="Next frame (→)" disabled={!doc || index >= doc.frames.length - 1} onClick={() => step(1)}>
          <ChevronRight size={16} />
        </button>
        <span className="grow" />
        <button className="player-btn" title="Restart (R)" onClick={restart}>
          <RotateCcw size={15} />
        </button>
        <button className="player-btn" title="Fullscreen (F)" onClick={() => void document.documentElement.requestFullscreen?.()}>
          <Maximize size={15} />
        </button>
      </div>
    </div>
  )
}
