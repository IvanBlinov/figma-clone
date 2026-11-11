// What the prototype player shows of one frame: the part that fits the device, with scrolled content moved and
// fixed layers pinned. Kept free of the DOM so it can be tested on its own.
import { buildIndex, computeWorld, descendants, kids, type DocIndex } from '../shared/doc'
import type { Mat } from '../shared/geometry'
import type { OverlayPosition, PrototypeDevice, SceneNode } from '../shared/types'

/** Scroll offsets of the frames on one screen, by frame id. */
export type Scroll = Readonly<Record<string, { x: number; y: number }>>
export interface Range {
  x: number
  y: number
}
export interface FrameView {
  id: string
  /** The frame with its scrolled content, re-rooted at 0,0 so it draws and hit-tests on its own. */
  ix: DocIndex
  world: Map<string, Mat>
  /** Visible size: the frame's own size, or the device's where the frame is larger and scrolls. */
  width: number
  height: number
  /** How far each scrollable frame on the screen can scroll, by id (only frames that can scroll at all). */
  ranges: Map<string, Range>
}

const scrollsX = (n: SceneNode) => n.overflowDirection === 'HORIZONTAL' || n.overflowDirection === 'BOTH'
const scrollsY = (n: SceneNode) => n.overflowDirection === 'VERTICAL' || n.overflowDirection === 'BOTH'

/** The visible size of a top-level frame: as Figma does, a frame larger than the device scrolls (unless it is set to NONE). */
export function viewportOf(frame: SceneNode, device?: PrototypeDevice | null): { width: number; height: number } {
  const o = frame.overflowDirection
  if (!device || o === 'NONE') return { width: frame.width, height: frame.height }
  // Unset scrolls whichever way the frame is larger; a set direction limits it to that axis.
  const x = !o || o === 'HORIZONTAL' || o === 'BOTH'
  const y = !o || o === 'VERTICAL' || o === 'BOTH'
  return { width: x ? Math.min(frame.width, device.width) : frame.width, height: y ? Math.min(frame.height, device.height) : frame.height }
}

/** How far a nested frame's content reaches past its own edges. */
function contentRange(ix: DocIndex, n: SceneNode): Range {
  let right = 0
  let bottom = 0
  for (const id of kids(ix, n.id)) {
    const c = ix.byId.get(id)!
    if (c.visible === false) continue
    right = Math.max(right, c.x + c.width)
    bottom = Math.max(bottom, c.y + c.height)
  }
  return {
    x: scrollsX(n) ? Math.max(0, right + (n.paddingRight ?? 0) - n.width) : 0,
    y: scrollsY(n) ? Math.max(0, bottom + (n.paddingBottom ?? 0) - n.height) : 0,
  }
}

const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max)

/** One axis of a fixed layer on a frame cut by `cut` from `size`: its constraint decides how it follows the device's edges. */
function pinAxis(pos: number, len: number, c: string | undefined, cut: number, size: number): [number, number] {
  if (!cut) return [pos, len]
  if (c === 'MAX') return [pos - cut, len]
  if (c === 'CENTER') return [pos - cut / 2, len]
  if (c === 'STRETCH') return [pos, Math.max(0, len - cut)]
  if (c === 'SCALE') {
    const k = (size - cut) / size
    return [pos * k, len * k]
  }
  return [pos, len]
}

/** Where a fixed layer of a top-level frame sits on the device. */
function pinned(c: SceneNode, cutX: number, cutY: number, frame: SceneNode): Pick<SceneNode, 'x' | 'y' | 'width' | 'height'> {
  const [x, width] = pinAxis(c.x, c.width, c.constraints?.horizontal, cutX, frame.width)
  const [y, height] = pinAxis(c.y, c.height, c.constraints?.vertical, cutY, frame.height)
  return { x, y, width, height }
}

/**
 * The view of `frameId` (a top-level frame, already laid out) at the given scroll offsets on a device. Offsets past
 * the end are clamped. Only the frame and what is inside it end up in the view.
 */
export function frameView(ix: DocIndex, frameId: string, device: PrototypeDevice | null | undefined, scroll: Scroll): FrameView {
  const frame = ix.byId.get(frameId)!
  const vp = viewportOf(frame, device)
  const cutX = frame.width - vp.width
  const cutY = frame.height - vp.height
  const ranges = new Map<string, Range>()
  if (cutX > 0 || cutY > 0) ranges.set(frameId, { x: cutX, y: cutY })
  const ids = descendants(ix, frameId)
  for (const id of ids) {
    const n = ix.byId.get(id)!
    if (n.type !== 'FRAME' || !n.overflowDirection || n.overflowDirection === 'NONE') continue
    const r = contentRange(ix, n)
    if (r.x > 0 || r.y > 0) ranges.set(id, r)
  }
  const offset = (id: string) => {
    const r = ranges.get(id)
    const s = scroll[id]
    return r && s ? { x: clamp(s.x, r.x), y: clamp(s.y, r.y) } : { x: 0, y: 0 }
  }
  const moved = new Map<string, SceneNode>()
  // The frame itself, re-rooted. Cut to the device, it clips as a phone screen does; otherwise it is drawn as authored.
  const cut = cutX > 0 || cutY > 0
  moved.set(frameId, { ...frame, parentId: undefined, x: 0, y: 0, rotation: 0, width: vp.width, height: vp.height, clipsContent: cut ? true : frame.clipsContent })
  for (const parent of [frameId, ...ids]) {
    if (!ranges.has(parent) && parent !== frameId) continue
    const o = offset(parent)
    for (const id of kids(ix, parent)) {
      const c = moved.get(id) ?? ix.byId.get(id)!
      if (c.scrollBehavior === 'FIXED') {
        if (parent === frameId) moved.set(id, { ...c, ...pinned(c, cutX, cutY, frame) })
        continue
      }
      if (o.x || o.y) moved.set(id, { ...c, x: c.x - o.x, y: c.y - o.y })
    }
  }
  const nodes = [moved.get(frameId)!, ...ids.map((id) => moved.get(id) ?? ix.byId.get(id)!)]
  const view = buildIndex(nodes)
  return { id: frameId, ix: view, world: computeWorld(view), width: vp.width, height: vp.height, ranges }
}

/**
 * Scroll a screen: the first frame in `path` (deepest first) that can still move along the gesture's main axis takes
 * the whole delta. Returns the new offsets, or null when nothing on the path can scroll that way.
 */
export function scrollBy(view: FrameView, scroll: Scroll, path: string[], dx: number, dy: number): Scroll | null {
  const vertical = Math.abs(dy) >= Math.abs(dx)
  for (const id of path) {
    const r = view.ranges.get(id)
    if (!r) continue
    const cur = scroll[id] ?? { x: 0, y: 0 }
    const x = clamp(cur.x, r.x)
    const y = clamp(cur.y, r.y)
    const nx = vertical ? x : clamp(x + dx, r.x)
    const ny = vertical ? clamp(y + dy, r.y) : y
    if (nx === x && ny === y) continue
    return { ...scroll, [id]: { x: nx, y: ny } }
  }
  return null
}

/** Top-left corner of an overlay of size w × h on a stage, by Figma's overlay positions. */
export function overlayOrigin(position: OverlayPosition | undefined, stage: { x: number; y: number; w: number; h: number }, w: number, h: number): { x: number; y: number } {
  const p = position ?? 'CENTER'
  const x = p.endsWith('LEFT') ? stage.x : p.endsWith('RIGHT') ? stage.x + stage.w - w : stage.x + (stage.w - w) / 2
  const y = p.startsWith('TOP') ? stage.y : p.startsWith('BOTTOM') ? stage.y + stage.h - h : stage.y + (stage.h - h) / 2
  return { x, y }
}
