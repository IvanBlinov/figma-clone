// In-canvas text editing: a hidden textarea receives input while the caret and selection are drawn on the canvas.
import { nextOrder, ROOT } from '../../shared/doc'
import { apply, invert, type Pt } from '../../shared/geometry'
import { caretRect, indexAtPoint, layoutText, lineIndexOf, spliceRuns, wordRange, wrapWidthOf, type TextLayout } from '../../shared/text'
import type { SceneNode } from '../../shared/types'
import { commitDraft, deleteNodes, preview } from './actions'
import { measureText } from './fonts'
import { clearDraft, commit, patchState, S, select, setTool } from './store'

let proxy: HTMLTextAreaElement | null = null
let orig: { id: string; name: string; characters: string } | null = null
/** Preferred x while moving the caret up/down. */
let goalX: number | null = null

export function registerProxy(el: HTMLTextAreaElement | null) {
  proxy = el
}
export const focusProxy = () => proxy?.focus({ preventScroll: true })

export const textLayoutOf = (n: SceneNode): TextLayout => layoutText(n, measureText, wrapWidthOf(n))

export function setTextSel(start: number, end: number, keepGoal = false) {
  if (!keepGoal) goalX = null
  patchState({ textSel: { start, end }, caretOn: true })
  if (proxy) {
    const a = Math.min(start, end)
    const b = Math.max(start, end)
    try {
      proxy.setSelectionRange(a, b, end < start ? 'backward' : 'forward')
    } catch {
      /* not focusable yet */
    }
  }
}

export function startTextEdit(id: string) {
  const n = S().doc.byId.get(id)
  if (!n) return
  orig = { id, name: n.name, characters: n.characters ?? '' }
  const len = (n.characters ?? '').length
  patchState({ editingId: id, selection: [id], vedit: null, textSel: { start: 0, end: len }, caretOn: true })
}

export function finishTextEdit() {
  const st = S()
  const id = st.editingId
  if (!id) return
  patchState({ editingId: null, textSel: null })
  const fresh = st.draftNew.find((n) => n.id === id)
  if (fresh) {
    if ((fresh.characters ?? '').trim()) {
      const n = { ...fresh, name: fresh.characters!.split('\n')[0].slice(0, 40), order: nextOrder(st.doc, fresh.parentId ?? ROOT) }
      commit([{ op: 'create', node: n }], { select: [id] })
    } else {
      clearDraft()
      select([])
    }
    setTool('move')
    return
  }
  const cur = st.doc.byId.get(id)
  if (!cur) return clearDraft()
  if (!(cur.characters ?? '').trim()) {
    clearDraft()
    return deleteNodes([id])
  }
  const first = (cur.characters ?? '').split('\n')[0].slice(0, 40)
  const o = orig?.id === id ? orig : null
  const autoNamed = !!o && (o.name === 'Text' || o.name === o.characters.split('\n')[0].slice(0, 40))
  if (autoNamed && cur.name !== first) preview([id], { name: first })
  if (Object.keys(S().draft).length) commitDraft()
}

/** Text typed / deleted in the proxy textarea. */
export function applyTextInput(value: string) {
  const st = S()
  const id = st.editingId
  const n = id ? st.doc.byId.get(id) : undefined
  if (!id || !n) return
  const old = n.characters ?? ''
  if (value === old) return
  let p = 0
  const max = Math.min(old.length, value.length)
  while (p < max && old[p] === value[p]) p++
  let s = 0
  while (s < max - p && old[old.length - 1 - s] === value[value.length - 1 - s]) s++
  const runs = n.textRuns?.length ? spliceRuns(n.textRuns, p, old.length - p - s, value.length - p - s) : undefined
  preview([id], { characters: value, ...(n.textRuns ? { textRuns: runs?.length ? runs : undefined } : {}) })
}

const editing = (): { n: SceneNode; t: TextLayout } | null => {
  const st = S()
  const n = st.editingId ? st.doc.byId.get(st.editingId) : undefined
  return n ? { n, t: textLayoutOf(n) } : null
}

/** Character index under a world point, or null when the point is outside the text box. */
export function textIndexAt(p: Pt, pad = 0): number | null {
  const st = S()
  const e = editing()
  if (!e) return null
  const q = apply(invert(st.world.get(e.n.id)!), p)
  if (q.x < -pad || q.y < -pad || q.x > e.n.width + pad || q.y > e.n.height + pad) return null
  return indexAtPoint(e.n, e.t, measureText, q.x, q.y)
}

export function selectWordAt(index: number) {
  const e = editing()
  if (!e) return
  const [a, b] = wordRange(e.n.characters ?? '', index)
  setTextSel(a, b)
}

export function selectAllText() {
  const e = editing()
  if (e) setTextSel(0, (e.n.characters ?? '').length)
}

/** Arrow up / down using the canvas layout (the proxy textarea wraps differently). */
export function moveCaretVertical(dir: -1 | 1, extend: boolean) {
  const st = S()
  const e = editing()
  if (!e || !st.textSel) return
  const c = caretRect(e.n, e.t, measureText, st.textSel.end)
  goalX ??= c.x
  const li = lineIndexOf(e.t, st.textSel.end) + dir
  let idx: number
  if (li < 0) idx = 0
  else if (li >= e.t.lines.length) idx = (e.n.characters ?? '').length
  else idx = indexAtPoint(e.n, e.t, measureText, goalX, 0, li)
  setTextSel(extend ? st.textSel.start : idx, idx, true)
}

export function moveCaretLineEdge(toEnd: boolean, extend: boolean) {
  const st = S()
  const e = editing()
  if (!e || !st.textSel) return
  const line = e.t.lines[lineIndexOf(e.t, st.textSel.end)]
  const idx = toEnd ? line.end : line.start
  setTextSel(extend ? st.textSel.start : idx, idx)
}

/** Pull the selection from the proxy (after native keyboard navigation). */
export function syncSelFromProxy() {
  if (!proxy || document.activeElement !== proxy) return
  const st = S()
  if (!st.editingId) return
  const back = proxy.selectionDirection === 'backward'
  const start = back ? proxy.selectionEnd : proxy.selectionStart
  const end = back ? proxy.selectionStart : proxy.selectionEnd
  if (st.textSel?.start !== start || st.textSel?.end !== end) {
    goalX = null
    patchState({ textSel: { start, end }, caretOn: true })
  }
}
