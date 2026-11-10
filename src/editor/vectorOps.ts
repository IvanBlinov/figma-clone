// Vector point editing commands (enter / exit, hit testing, delete, nudge, smooth toggle).
import { apply, type Pt } from '../../shared/geometry'
import { cubicAt, segmentsOf, splitSegment, type SubPath } from '../../shared/vector'
import { deleteNodes } from './actions'
import { commit, patchState, S } from './store'
import { cloneSubs, editSubs, flatPoints, hasHandles, rebound } from './vectorEdit'

export function enterVectorEdit(id: string) {
  const n = S().doc.byId.get(id)
  if (!n || n.type !== 'VECTOR' || n.locked) return
  patchState({ vedit: { id, sel: [] }, selection: [id], editingId: null, tool: 'move' })
}

export const exitVectorEdit = () => patchState({ vedit: null })

export function veditNode() {
  const st = S()
  const n = st.vedit ? st.doc.byId.get(st.vedit.id) : undefined
  return n && n.type === 'VECTOR' ? n : null
}

export type VHit =
  | { type: 'anchor'; index: number }
  | { type: 'handle'; index: number; which: 'in' | 'out' }
  | { type: 'segment'; s: number; a: number; b: number; t: number }

/** What is under a screen point while editing a vector. */
export function vectorHit(sx: number, sy: number): VHit | null {
  const st = S()
  const n = veditNode()
  if (!n) return null
  const m = st.world.get(n.id)!
  const vp = st.viewport
  const sc = (x: number, y: number): Pt => {
    const p = apply(m, { x, y })
    return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y }
  }
  const near = (p: Pt, r: number) => Math.hypot(p.x - sx, p.y - sy) <= r
  const subs = editSubs(n)
  const flat = flatPoints(subs)
  for (const idx of st.vedit!.sel) {
    const f = flat[idx]
    if (!f) continue
    if ((f.p.ox !== f.p.x || f.p.oy !== f.p.y) && near(sc(f.p.ox, f.p.oy), 6)) return { type: 'handle', index: idx, which: 'out' }
    if ((f.p.ix !== f.p.x || f.p.iy !== f.p.y) && near(sc(f.p.ix, f.p.iy), 6)) return { type: 'handle', index: idx, which: 'in' }
  }
  for (let i = 0; i < flat.length; i++) if (near(sc(flat[i].p.x, flat[i].p.y), 7)) return { type: 'anchor', index: i }
  let best: VHit | null = null
  let bestD = 5
  subs.forEach((sub, s) => {
    for (const [a, b] of segmentsOf(sub))
      for (let k = 1; k < 24; k++) {
        const t = k / 24
        const pt = cubicAt(sub.pts[a], sub.pts[b], t)
        const d = Math.hypot(sc(pt.x, pt.y).x - sx, sc(pt.x, pt.y).y - sy)
        if (d < bestD) {
          bestD = d
          best = { type: 'segment', s, a, b, t }
        }
      }
  })
  return best
}

function commitSubs(subs: SubPath[], sel?: number[]) {
  const n = veditNode()
  if (!n) return
  const live = subs.filter((s) => s.pts.length >= 2)
  if (!live.length) {
    exitVectorEdit()
    return deleteNodes([n.id])
  }
  commit([{ op: 'update', id: n.id, patch: rebound(n, live) as Record<string, unknown> }])
  if (sel) patchState({ vedit: { id: n.id, sel } })
}

/** Write the current (possibly dragged) path back with a refitted bounding box. */
export function commitVectorEdit() {
  const n = veditNode()
  if (n) commitSubs(cloneSubs(editSubs(n)))
}

export function insertVectorPoint(hit: Extract<VHit, { type: 'segment' }>) {
  const n = veditNode()
  if (!n) return
  const subs = cloneSubs(editSubs(n))
  const sub = subs[hit.s]
  const r = splitSegment(sub.pts[hit.a], sub.pts[hit.b], hit.t)
  sub.pts[hit.a] = r.a
  sub.pts[hit.b] = r.b
  const at = hit.b === 0 ? sub.pts.length : hit.b
  sub.pts.splice(at, 0, r.mid)
  let index = at
  for (let i = 0; i < hit.s; i++) index += subs[i].pts.length
  commitSubs(subs, [index])
}

export function deleteVectorPoints() {
  const st = S()
  const n = veditNode()
  if (!n || !st.vedit!.sel.length) return
  const sel = new Set(st.vedit!.sel)
  let idx = 0
  const subs = cloneSubs(editSubs(n)).map((s) => ({ ...s, pts: s.pts.filter(() => !sel.has(idx++)) }))
  commitSubs(subs, [])
}

export function nudgeVectorPoints(dx: number, dy: number) {
  const st = S()
  const n = veditNode()
  if (!n || !st.vedit!.sel.length) return
  const subs = cloneSubs(editSubs(n))
  const flat = flatPoints(subs)
  for (const i of st.vedit!.sel) {
    const p = flat[i]?.p
    if (!p) continue
    p.x += dx
    p.ix += dx
    p.ox += dx
    p.y += dy
    p.iy += dy
    p.oy += dy
  }
  commitSubs(subs)
}

/** Double-click an anchor: corner ⇄ smooth. */
export function toggleSmooth(index: number) {
  const n = veditNode()
  if (!n) return
  const subs = cloneSubs(editSubs(n))
  const f = flatPoints(subs)[index]
  if (!f) return
  const sub = subs[f.s]
  const p = f.p
  if (hasHandles(p)) {
    p.ix = p.ox = p.x
    p.iy = p.oy = p.y
  } else {
    const len = sub.pts.length
    const prev = sub.pts[f.i - 1] ?? (sub.closed ? sub.pts[len - 1] : undefined)
    const next = sub.pts[f.i + 1] ?? (sub.closed ? sub.pts[0] : undefined)
    const a = prev ?? p
    const b = next ?? p
    const tx = (b.x - a.x) / 6
    const ty = (b.y - a.y) / 6
    p.ix = p.x - tx
    p.iy = p.y - ty
    p.ox = p.x + tx
    p.oy = p.y + ty
  }
  commitSubs(subs, [index])
}
