// Poster capture for video fills: when a video without a `posterUrl` has loaded its first frame in an editable
// file, that frame is uploaded as a JPEG and written onto the paint, so exports, thumbnails, CSS and clients that
// have not loaded the video yet have a still to show.
import type { Op, SceneNode } from '../../shared/types'
import { placeImageUrl } from './actions'
import { captureVideoFrame, onVideoReady, readyVideo } from './render'
import { commit, S, useEditor } from './store'

/** Video URL → the poster uploaded for it in this session (null: capture or upload failed, do not try again). */
const posters = new Map<string, Promise<string | null | typeof SKIP>>()
/** `${nodeId}|${videoUrl}` → how many times this session wrote a poster there. Bounds any write loop. */
const writes = new Map<string, number>()
/** URLs with a capture / write in flight. */
const busy = new Set<string>()
const SKIP = Symbol('skip')
const MAX_WRITES = 3 // more than one only so that undo → redo of "set video fill" gets its poster back

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const key = (id: string, url: string) => `${id}|${url}`

function needsPoster(n: SceneNode, url: string): boolean {
  if (!n.fills?.some((p) => p.type === 'VIDEO' && p.url === url && !p.posterUrl)) return false
  // Instance members mirror their main component, which gets the poster itself.
  if ((n.sourceId || n.componentId) && !n.overrides?.includes('fills')) return false
  return (writes.get(key(n.id, url)) ?? 0) < MAX_WRITES
}
const wanted = (url: string) => {
  const st = S()
  return !st.readOnly && !!st.pageId && st.raw.some((n) => needsPoster(n, url))
}
/** A commit resets in-flight edits, so wait for a quiet moment. */
const editing = () => {
  const st = S()
  return Object.keys(st.draft).length > 0 || st.draftNew.length > 0 || !!st.editingId || !!st.vedit
}

async function run(url: string) {
  if (busy.has(url) || !wanted(url)) return
  busy.add(url)
  try {
    let job = posters.get(url)
    if (!job) {
      const el = readyVideo(url)
      if (!el) return
      // Grab the frame now (right after `loadeddata` this is the first one); null when the canvas is tainted.
      const frame = captureVideoFrame(el)
      job = (async () => {
        const blob = await frame
        if (!blob) return null
        // Several clients may have the file open: wait a random moment, then only upload if nobody else has
        // written a poster in the meantime.
        await sleep(300 + Math.random() * 2700)
        if (!wanted(url)) return SKIP
        try {
          return await placeImageUrl(blob)
        } catch {
          return null
        }
      })()
      posters.set(url, job)
    }
    const poster = await job
    if (poster === SKIP) {
      if (posters.get(url) === job) posters.delete(url)
      return
    }
    if (!poster) return
    for (let i = 0; editing() && i < 100; i++) await sleep(300)
    if (editing()) return
    const st = S()
    if (st.readOnly || !st.pageId) return
    const ops: Op[] = []
    for (const n of st.raw) {
      if (!needsPoster(n, url)) continue
      writes.set(key(n.id, url), (writes.get(key(n.id, url)) ?? 0) + 1)
      const fills = n.fills!.map((p) => (p.type === 'VIDEO' && p.url === url && !p.posterUrl ? { ...p, posterUrl: poster } : p))
      ops.push({ op: 'update', id: n.id, patch: { fills } })
    }
    // A regular document change (synced to everyone), but not an undo step of its own.
    if (ops.length) commit(ops, { history: false })
  } catch {
    /* posters are best-effort */
  } finally {
    busy.delete(url)
  }
}

/** Videos already loaded in this session whose paint (new node, redo, other page) still lacks a poster. */
function scan() {
  const st = S()
  if (st.readOnly) return
  const urls = new Set<string>()
  for (const n of st.raw) for (const p of n.fills ?? []) if (p.type === 'VIDEO' && p.url && !p.posterUrl) urls.add(p.url)
  for (const url of urls) if (readyVideo(url)) void run(url)
}

/** Start capturing posters for the open file. Returns a cleanup function. */
export function installVideoPosters(): () => void {
  const offReady = onVideoReady((url) => void run(url))
  const offStore = useEditor.subscribe((s, prev) => {
    if (s.raw !== prev.raw || s.readOnly !== prev.readOnly) scan()
  })
  return () => {
    offReady()
    offStore()
  }
}
