// PNG rendering for previews. Remote images are downloaded and embedded before drawing, so a preview either shows
// every image or says which ones it could not draw. Each image is shrunk to the size it is drawn at first: resvg decodes
// every embedded image at full resolution, and a page of full-size screenshots needs more memory than the hosted
// server has (512 MB), even for a small preview.
import { Resvg } from '@resvg/resvg-js'
import sharp from 'sharp'
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
/** Pixels one image may have before it is shrunk (sharp decodes it in strips, so this bounds work, not memory). */
const MAX_SOURCE_PIXELS = 100_000_000
/** Pixels all the images of one preview may add up to once shrunk, as resvg holds them all decoded at once. */
const MAX_TOTAL_PIXELS = 40_000_000
/** Images are kept at twice the size they are drawn at, so edges stay crisp. */
const SHARPNESS = 2
/** Shrinking is skipped when it would save little. */
const MIN_SHRINK = 0.75

/** Pixel size of a PNG, JPEG, GIF or WebP from its header, or null for anything else (an SVG, a broken file). */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
  }
  return null
}

/**
 * How much an image can be shrunk: the largest factor any layer using it needs, so it still covers every layer
 * (FILL crops, so it takes the larger of the two axis ratios) at the preview scale.
 */
export function shrinkFactor(image: { w: number; h: number }, layers: { w: number; h: number }[], scale: number): number {
  const need = Math.max(0, ...layers.map((l) => Math.max(l.w / image.w, l.h / image.h)))
  return need * scale * SHARPNESS
}

// No decoded-image cache: each image is shrunk once and then only its small copy is kept.
sharp.cache(false)

/** Resize an image to exactly w × h. JPEGs stay JPEG (photos, no transparency); everything else becomes PNG. */
async function shrink(buf: Buffer, type: string, w: number, h: number): Promise<{ buf: Buffer; mime: string }> {
  const img = sharp(buf, { limitInputPixels: MAX_SOURCE_PIXELS, animated: false }).resize(w, h, { fit: 'fill' })
  return type === 'image/jpeg' ? { buf: await img.jpeg({ quality: 85 }).toBuffer(), mime: 'image/jpeg' } : { buf: await img.png().toBuffer(), mime: 'image/png' }
}

/** The still image a paint is drawn with: the image itself, or the poster of a video. */
const stillOf = (p: { type: string; url?: string; posterUrl?: string }) => (p.type === 'IMAGE' ? p.url : p.type === 'VIDEO' ? p.posterUrl : undefined)

/**
 * Download the images used by these nodes (and everything inside them) as data URIs, keyed by their URL, each shrunk
 * to the size it is drawn at when the preview is rendered at `scale`.
 */
export async function inlineImages(ix: DocIndex, ids: string[], scale = 1): Promise<{ images: Map<string, string>; missing: MissingImage[]; total: number }> {
  const users = new Map<string, { nodeId: string; name: string; w: number; h: number }[]>()
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
        users.set(url, [...(users.get(url) ?? []), { nodeId: n.id, name: n.name, w: n.width, h: n.height }])
      }
    }
  const images = new Map<string, string>()
  const queue = [...users.keys()]
  const total = queue.length + missing.length
  let used = 0
  let pixels = 0
  const fail = (url: string, reason: string) => {
    for (const u of users.get(url)!) missing.push({ nodeId: u.nodeId, name: u.name, reason })
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
        let buf: Buffer = Buffer.from(await res.arrayBuffer())
        let mime = type
        if (buf.length > PER_IMAGE) {
          fail(url, `larger than ${PER_IMAGE / 1024 / 1024} MB`)
          continue
        }
        const size = imageSize(buf)
        let drawnPixels = 0
        if (size) {
          if (size.w * size.h > MAX_SOURCE_PIXELS) {
            fail(url, `${size.w}×${size.h} px is too large to decode`)
            continue
          }
          const f = shrinkFactor(size, users.get(url)!, scale)
          if (f < MIN_SHRINK) {
            const w = Math.max(1, Math.round(size.w * f))
            const h = Math.max(1, Math.round(size.h * f))
            try {
              ;({ buf, mime } = await shrink(buf, type, w, h))
            } catch {
              fail(url, 'could not be decoded')
              continue
            }
            drawnPixels = w * h
          } else drawnPixels = size.w * size.h
        }
        if (pixels + drawnPixels > MAX_TOTAL_PIXELS) fail(url, 'the images in this preview are too large to draw together at this scale; render a smaller part or a smaller size')
        else if (used + buf.length > TOTAL) fail(url, 'the images in this preview add up to more than 160 MB; render a smaller part')
        else {
          used += buf.length
          pixels += drawnPixels
          images.set(url, `data:${mime};base64,${buf.toString('base64')}`)
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
