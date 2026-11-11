// PNG rendering for previews. Remote images are downloaded and embedded before drawing, so a preview either shows
// every image or says which ones it could not draw.
import { Resvg } from '@resvg/resvg-js'
import { descendants, type DocIndex } from '../shared/doc'
import { fontOptions } from './fonts'

export interface MissingImage {
  nodeId: string
  name: string
  reason: string
}

const PER_IMAGE = 24 * 1024 * 1024
const TOTAL = 160 * 1024 * 1024
const CONCURRENCY = 8

/** The still image a paint is drawn with: the image itself, or the poster of a video. */
const stillOf = (p: { type: string; url?: string; posterUrl?: string }) => (p.type === 'IMAGE' ? p.url : p.type === 'VIDEO' ? p.posterUrl : undefined)

/** Download the images used by these nodes (and everything inside them) as data URIs, keyed by their URL. */
export async function inlineImages(ix: DocIndex, ids: string[]): Promise<{ images: Map<string, string>; missing: MissingImage[]; total: number }> {
  const users = new Map<string, { nodeId: string; name: string }[]>()
  const missing: MissingImage[] = []
  for (const id of ids)
    for (const nid of [id, ...descendants(ix, id)]) {
      const n = ix.byId.get(nid)
      if (!n || n.visible === false) continue
      for (const p of (n.fills ?? []) as { type: string; url?: string; posterUrl?: string; visible?: boolean }[]) {
        if (p.visible === false) continue
        if (p.type === 'VIDEO' && !p.posterUrl) {
          missing.push({ nodeId: n.id, name: n.name, reason: 'video without a poster frame yet (open the file in the editor once, or pass posterUrl)' })
          continue
        }
        const url = stillOf(p)
        if (!url || url.startsWith('data:')) continue
        if (!/^https?:/.test(url)) {
          missing.push({ nodeId: n.id, name: n.name, reason: 'not an http(s) URL' })
          continue
        }
        users.set(url, [...(users.get(url) ?? []), { nodeId: n.id, name: n.name }])
      }
    }
  const images = new Map<string, string>()
  const queue = [...users.keys()]
  const total = queue.length + missing.length
  let used = 0
  const fail = (url: string, reason: string) => {
    for (const u of users.get(url)!) missing.push({ ...u, reason })
  }
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) {
          fail(url, `HTTP ${res.status}`)
          continue
        }
        const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0]
        if (!/^image\//.test(type)) {
          fail(url, `not an image (${type})`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > PER_IMAGE) fail(url, `larger than ${PER_IMAGE / 1024 / 1024} MB`)
        else if (used + buf.length > TOTAL) fail(url, 'the images in this preview add up to more than 160 MB; render a smaller part')
        else {
          used += buf.length
          images.set(url, `data:${type};base64,${buf.toString('base64')}`)
        }
      } catch (e) {
        fail(url, e instanceof Error && e.name === 'TimeoutError' ? 'timed out after 30s' : 'could not be downloaded')
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return { images, missing, total }
}

/** One line for the tool result when some images are absent from the picture; empty when all were drawn. */
export function missingNote(missing: MissingImage[], total: number): string {
  if (!missing.length) return ''
  const list = missing.slice(0, 12).map((m) => `"${m.name}" (${m.nodeId}): ${m.reason}`)
  return `${missing.length} of ${total} image(s) are NOT drawn in this picture: ${list.join('; ')}${missing.length > 12 ? `; and ${missing.length - 12} more` : ''}`
}

export const svgToPng = (svg: string): Buffer => Buffer.from(new Resvg(svg, { font: fontOptions() }).render().asPng())
