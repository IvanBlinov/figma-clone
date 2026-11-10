// Prototype presentation view: plays the interactions defined in the editor's Prototype tab.
import { useQuery } from 'convex/react'
import { ChevronLeft, ChevronRight, Maximize, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { buildIndex, computeWorld, descendants, kids, ROOT, type DocIndex } from '../shared/doc'
import type { Mat } from '../shared/geometry'
import { runLayout } from '../shared/layout'
import type { Reaction, SceneNode } from '../shared/types'
import { ensureFont, measureText, onFontsChanged } from './editor/fonts'
import { hitPath } from './editor/hit'
import { drawNodes, setImageLoadCallback } from './editor/render'

interface Doc {
  ix: DocIndex
  world: Map<string, Mat>
  frames: string[]
}
interface Anim {
  from: string
  to: string
  transition: NonNullable<Reaction['transition']>
  direction: NonNullable<Reaction['direction']>
  easing: NonNullable<Reaction['easing']>
  duration: number
  t0: number
}
interface State {
  stack: { id: string; via?: Reaction }[]
  overlays: { id: string; t0: number; hover?: string }[]
  anim: Anim | null
  hover: string | null
  flash: number
}

const ease = (t: number, e: string) => (e === 'LINEAR' ? t : e === 'EASE_IN' ? t * t : e === 'EASE_IN_OUT' ? t * t * (3 - 2 * t) : 1 - (1 - t) * (1 - t))
const OPPOSITE = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as const
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function mixColor(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return '#' + [0, 1, 2].map((i) => Math.round(lerp(p(a, i), p(b, i), t)).toString(16).padStart(2, '0')).join('')
}

/** Destination frame with layers that also exist (by name) in the source frame interpolated from their old state. */
function smartIndex(ix: DocIndex, fromId: string, toId: string, t: number): DocIndex {
  const key = (root: string, id: string) => {
    const parts: string[] = []
    let cur = ix.byId.get(id)
    while (cur && cur.id !== root) {
      parts.push(cur.type + ':' + cur.name)
      cur = cur.parentId ? ix.byId.get(cur.parentId) : undefined
    }
    return parts.join('/')
  }
  const src = new Map<string, SceneNode>()
  for (const id of descendants(ix, fromId)) {
    const k = key(fromId, id)
    if (!src.has(k)) src.set(k, ix.byId.get(id)!)
  }
  const to = ix.byId.get(toId)!
  const out: SceneNode[] = [to]
  for (const id of descendants(ix, toId)) {
    const b = ix.byId.get(id)!
    const a = src.get(key(toId, id))
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
  const stored = useQuery(api.nodes.list, page ? { pageId: page._id } : 'skip') as SceneNode[] | undefined
  const [tick, setTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useRef<State>({ stack: [], overlays: [], anim: null, hover: null, flash: 0 })
  const [current, setCurrent] = useState<string | null>(null)
  const redraw = useRef<() => void>(() => {})

  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const a = onFontsChanged(bump)
    const b = setImageLoadCallback(bump)
    return () => {
      a()
      b()
    }
  }, [])

  const doc: Doc | null = useMemo(() => {
    if (!stored) return null
    for (const n of stored) if (n.type === 'TEXT') ensureFont(n.fontFamily ?? 'Inter', n.fontWeight ?? 400, !!n.italic)
    const res = runLayout(stored, measureText)
    const frames = kids(res.index, ROOT).filter((id) => res.index.byId.get(id)!.type === 'FRAME' && res.index.byId.get(id)!.visible !== false)
    return { ix: res.index, world: computeWorld(res.index), frames }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, tick])
  const docRef = useRef(doc)
  docRef.current = doc

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
      st.stack = [{ id: startId }]
      st.overlays = []
      st.anim = null
      setCurrent(startId)
    }
    redraw.current()
  }, [startId, doc])

  useEffect(() => {
    document.title = file ? `${file.name} – Prototype` : 'Prototype'
  }, [file?.name])

  // ---------- geometry ----------
  const layoutOf = (id: string) => {
    const d = docRef.current!
    const f = d.ix.byId.get(id)!
    const vw = window.innerWidth
    const vh = window.innerHeight - 48
    const base = d.ix.byId.get(state.current.stack[state.current.stack.length - 1]?.id ?? id) ?? f
    const s = Math.min(1, vw / base.width, vh / base.height)
    return { f, s, x: (vw - f.width * s) / 2, y: (vh - f.height * s) / 2 }
  }

  // ---------- actions ----------
  const top = () => state.current.stack[state.current.stack.length - 1]?.id ?? null

  const go = (to: string, r?: Reaction, back = false) => {
    const st = state.current
    const d = docRef.current
    const from = top()
    if (!d || !from || !d.ix.byId.has(to) || st.anim) return
    st.overlays = []
    const transition = r?.transition ?? 'INSTANT'
    if (back) st.stack.pop()
    else st.stack.push({ id: to, via: r })
    if (transition !== 'INSTANT' && from !== to)
      st.anim = {
        from,
        to,
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
          st.overlays.push({ id: r.destinationId, t0: performance.now(), hover: r.trigger === 'ON_HOVER' ? sourceId : undefined })
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
    st.stack = [{ id: startId }]
    st.overlays = []
    st.anim = null
    setCurrent(startId)
    redraw.current()
  }

  /** Nodes under a screen point inside a frame, deepest first, ending with the frame itself. */
  const pathAt = (frame: string, cx: number, cy: number): string[] | null => {
    const d = docRef.current!
    const l = layoutOf(frame)
    const lx = (cx - l.x) / l.s
    const ly = (cy - l.y) / l.s
    if (lx < 0 || ly < 0 || lx > l.f.width || ly > l.f.height) return null
    const p = { x: l.f.x + lx, y: l.f.y + ly }
    const path = hitPath({ doc: d.ix, world: d.world, viewport: { x: 0, y: 0, zoom: l.s } }, p, undefined, frame)
    return [...path.reverse(), frame]
  }
  const reactionAt = (cx: number, cy: number, triggers: Reaction['trigger'][]): { r: Reaction; id: string } | 'outside' | null => {
    const st = state.current
    const d = docRef.current
    const cur = top()
    if (!d || !cur) return null
    const over = st.overlays[st.overlays.length - 1]
    const path = pathAt(over?.id ?? cur, cx, cy)
    if (!path) return over ? 'outside' : null
    for (const id of path) {
      const r = d.ix.byId.get(id)?.reactions?.find((x) => triggers.includes(x.trigger))
      if (r) return { r, id }
    }
    return null
  }

  // ---------- drawing ----------
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    const draw = () => {
      raf = 0
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
      const cur = top()
      if (!d || !cur || !d.ix.byId.has(cur)) return
      let again = false
      const screen = (ix: DocIndex, id: string, alpha: number, ox = 0, oy = 0) => {
        const l = layoutOf(id)
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.beginPath()
        // Keep sliding screens inside the stage of the current frame.
        const stage = layoutOf(cur)
        ctx.rect(stage.x * dpr, stage.y * dpr, stage.f.width * stage.s * dpr, stage.f.height * stage.s * dpr)
        if (ox || oy) ctx.clip()
        ctx.globalAlpha = alpha
        const k = l.s * dpr
        ctx.setTransform(k, 0, 0, k, (l.x + ox) * dpr - l.f.x * k, (l.y + oy) * dpr - l.f.y * k)
        drawNodes(ctx, ix, [id], k)
        ctx.restore()
      }
      const a = st.anim
      if (a && d.ix.byId.has(a.from) && d.ix.byId.has(a.to)) {
        const raw = Math.min(1, (performance.now() - a.t0) / a.duration)
        const e = ease(raw, a.easing)
        const l = layoutOf(a.to)
        const vx = a.direction === 'LEFT' ? l.f.width * l.s : a.direction === 'RIGHT' ? -l.f.width * l.s : 0
        const vy = a.direction === 'TOP' ? l.f.height * l.s : a.direction === 'BOTTOM' ? -l.f.height * l.s : 0
        switch (a.transition) {
          case 'DISSOLVE':
            screen(d.ix, a.from, 1)
            screen(d.ix, a.to, e)
            break
          case 'MOVE_IN':
            screen(d.ix, a.from, 1)
            screen(d.ix, a.to, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'PUSH':
            screen(d.ix, a.from, 1, -vx * e, -vy * e)
            screen(d.ix, a.to, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'SLIDE_IN':
            screen(d.ix, a.from, 1 - 0.4 * e, -vx * e * 0.3, -vy * e * 0.3)
            screen(d.ix, a.to, 1, vx * (1 - e), vy * (1 - e))
            break
          case 'SMART_ANIMATE':
            screen(d.ix, a.from, 1)
            screen(smartIndex(d.ix, a.from, a.to, e), a.to, Math.min(1, e * 3))
            break
          default:
            screen(d.ix, a.to, 1)
        }
        if (raw >= 1) st.anim = null
        again = true
      } else {
        st.anim = null
        screen(d.ix, cur, 1)
      }
      for (const o of st.overlays) {
        if (!d.ix.byId.has(o.id)) continue
        const t = Math.min(1, (performance.now() - o.t0) / 180)
        if (t < 1) again = true
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const stage = layoutOf(cur)
        ctx.fillStyle = `rgba(0,0,0,${0.3 * t})`
        ctx.fillRect(stage.x, stage.y, stage.f.width * stage.s, stage.f.height * stage.s)
        screen(d.ix, o.id, t)
      }
      // Hotspot hints after a click that hit nothing.
      const flashAge = performance.now() - st.flash
      if (flashAge < 450) {
        again = true
        const host = st.overlays[st.overlays.length - 1]?.id ?? cur
        const l = layoutOf(host)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = `rgba(13,153,255,${0.35 * (1 - flashAge / 450)})`
        for (const id of [host, ...descendants(d.ix, host)]) {
          const n = d.ix.byId.get(id)!
          if (id === host || !n.reactions?.some((r) => r.trigger === 'ON_CLICK' || r.trigger === 'ON_PRESS')) continue
          const m = d.world.get(id)!
          ctx.fillRect(l.x + (m[4] - l.f.x) * l.s, l.y + (m[5] - l.f.y) * l.s, n.width * l.s, n.height * l.s)
        }
      }
      if (again) raf = requestAnimationFrame(draw)
    }
    redraw.current = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const onResize = () => redraw.current()
    window.addEventListener('resize', onResize)
    redraw.current()
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
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

  const onClick = (e: React.MouseEvent) => {
    const st = state.current
    if (st.anim) return
    const hit = reactionAt(e.clientX, e.clientY, ['ON_CLICK', 'ON_PRESS'])
    if (hit === 'outside') {
      st.overlays.pop()
      return redraw.current()
    }
    if (hit) return run(hit.r, hit.id)
    st.flash = performance.now()
    redraw.current()
  }
  const onMove = (e: React.MouseEvent) => {
    const st = state.current
    const click = reactionAt(e.clientX, e.clientY, ['ON_CLICK', 'ON_PRESS'])
    canvasRef.current!.style.cursor = click && click !== 'outside' ? 'pointer' : 'default'
    const hov = reactionAt(e.clientX, e.clientY, ['ON_HOVER'])
    const id = hov && hov !== 'outside' ? hov.id : null
    if (id === st.hover) return
    // Leaving the layer that opened a hover overlay closes it (unless the pointer moved onto the overlay itself).
    const overHoverOverlay = st.overlays.some((o) => o.hover && pathAt(o.id, e.clientX, e.clientY))
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
      <canvas ref={canvasRef} onClick={onClick} onMouseMove={onMove} style={{ width: '100%', height: '100%', display: 'block' }} />
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
