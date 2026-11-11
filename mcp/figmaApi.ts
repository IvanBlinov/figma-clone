// A Figma Plugin API compatible scripting surface (`figma` global) over the clone's document model.
// Used by the use_figma tool: scripts written for Figma's plugin API run against in-memory copies of the
// file's pages; the caller diffs the result and stores it.
// This module must stay free of Node APIs: it is bundled and executed inside the QuickJS sandbox (see sandbox.ts).
import { descendants, kids, worldMatrix, type DocIndex } from '../shared/doc'
import { boundsOf, corners } from '../shared/geometry'
import { svgToNodes } from '../shared/svgParse'
import { overrideKeys } from '../shared/resolve'
import { estimateMeasure, styleRange } from '../shared/text'
import { runLayout } from '../shared/layout'
import { defaultsFor, isAutoLayout, newId, type Effect, type NodeType, type Paint, type SceneNode, type TextRunStyle } from '../shared/types'

export interface PageModel {
  pageId: string
  name: string
  nodes: SceneNode[]
  isNew?: boolean
}
export interface StyleModel {
  id: string
  /** EFFECT styles live only for the run: they are applied to layers but not saved as shared styles. */
  kind: 'PAINT' | 'TEXT' | 'EFFECT'
  name: string
  value: { paints?: Paint[]; text?: Record<string, unknown>; effects?: Effect[]; pluginData?: Record<string, string> }
  isNew?: boolean
  dirty?: boolean
  /** Removed by the script: deleted when the run is saved. */
  removed?: boolean
}
export interface RunResult {
  result: unknown
  logs: string[]
  warnings: string[]
  selection: { pageId: string; ids: string[] } | null
  currentPageId: string
}

type Rec = Record<string, unknown>
const WEIGHTS: Record<string, number> = { thin: 100, 'extra light': 200, extralight: 200, light: 300, regular: 400, medium: 500, 'semi bold': 600, semibold: 600, bold: 700, 'extra bold': 800, extrabold: 800, black: 900 }
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
const toHex = (c: { r: number; g: number; b: number } | string | undefined): string => {
  if (typeof c === 'string') return c.startsWith('#') ? c.toUpperCase() : '#' + c.toUpperCase()
  if (!c) return '#000000'
  return ('#' + hex2(c.r) + hex2(c.g) + hex2(c.b)).toUpperCase()
}
const toRgb = (hex: string) => {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }
}

function paintsFromFigma(list: unknown): Paint[] {
  if (!Array.isArray(list)) throw new Error('fills / strokes must be an array of paints')
  return list.map((raw) => {
    const p = raw as Rec
    const base: Rec = {}
    if (p.opacity !== undefined && p.opacity !== 1) base.opacity = p.opacity
    if (p.visible === false) base.visible = false
    if (p.type === 'SOLID') return { type: 'SOLID', color: toHex(p.color as string), ...base } as Paint
    if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
      const stops = ((p.gradientStops ?? p.stops) as Rec[]).map((s) => {
        const c = s.color as { r: number; g: number; b: number; a?: number } | string
        return { position: s.position as number, color: toHex(c), ...(typeof c === 'object' && c.a !== undefined && c.a < 1 ? { opacity: c.a } : s.opacity !== undefined ? { opacity: s.opacity as number } : {}) }
      })
      const t = p.gradientTransform as number[][] | undefined
      const angle = p.angle !== undefined ? (p.angle as number) : t ? Math.round((Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI) : 0
      return { type: p.type === 'GRADIENT_LINEAR' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL', stops, angle, ...base } as Paint
    }
    if (p.type === 'IMAGE') {
      const url = (p.url ?? p.imageHash) as string
      if (!url) throw new Error('IMAGE paints need imageHash (use the hash from figma.createImageAsync(url)) or url')
      return { type: 'IMAGE', url, scaleMode: p.scaleMode === 'FIT' ? 'FIT' : p.scaleMode === 'CROP' || p.scaleMode === 'STRETCH' ? 'STRETCH' : 'FILL', ...base } as Paint
    }
    if (p.type === 'VIDEO') {
      const url = (p.url ?? p.videoHash) as string
      if (!url) throw new Error('VIDEO paints need url')
      return { type: 'VIDEO', url, ...(p.posterUrl ? { posterUrl: p.posterUrl as string } : {}), scaleMode: p.scaleMode === 'FIT' ? 'FIT' : p.scaleMode === 'CROP' || p.scaleMode === 'STRETCH' ? 'STRETCH' : 'FILL', ...base } as Paint
    }
    throw new Error(`Unsupported paint type ${String(p.type)}`)
  })
}

function paintsToFigma(list: Paint[] | undefined): Rec[] {
  return (list ?? []).map((p) => {
    const base = { visible: p.visible !== false, opacity: p.opacity ?? 1, blendMode: 'NORMAL' }
    if (p.type === 'SOLID') return { type: 'SOLID', color: toRgb(p.color), ...base }
    if (p.type === 'IMAGE') return { type: 'IMAGE', imageHash: p.url, scaleMode: p.scaleMode ?? 'FILL', ...base }
    if (p.type === 'VIDEO') return { type: 'VIDEO', videoHash: p.url, url: p.url, ...(p.posterUrl ? { posterUrl: p.posterUrl } : {}), scaleMode: p.scaleMode ?? 'FILL', ...base }
    const a = ((p.angle ?? 0) * Math.PI) / 180
    return {
      type: p.type,
      gradientStops: p.stops.map((s) => ({ position: s.position, color: { ...toRgb(s.color), a: s.opacity ?? 1 } })),
      gradientTransform: [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a), Math.cos(a), 0],
      ],
      ...base,
    }
  })
}

// ---------- prototyping: Figma's reaction shape <-> this file's ----------
type CloneReaction = NonNullable<SceneNode['reactions']>[number]
const TRIGGERS = ['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'AFTER_TIMEOUT'] as const
const TRANSITIONS = ['DISSOLVE', 'SMART_ANIMATE', 'MOVE_IN', 'PUSH', 'SLIDE_IN'] as const
const EASINGS = ['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_OUT'] as const
const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v as string) ? (v as T) : undefined

/** Figma reactions ({trigger:{type}, actions:[{type:'NODE', destinationId, navigation, transition}]}) in this file's shape. Already-converted ones pass through. */
export function reactionsFromFigma(list: unknown): CloneReaction[] {
  if (!Array.isArray(list)) return []
  const out: CloneReaction[] = []
  for (const r of list as Rec[]) {
    if (typeof r.trigger === 'string') {
      out.push(r as unknown as CloneReaction)
      continue
    }
    const t = (r.trigger ?? {}) as Rec
    const trigger = pick(t.type === 'MOUSE_ENTER' ? 'ON_HOVER' : t.type, TRIGGERS) ?? 'ON_CLICK'
    const timeout = trigger === 'AFTER_TIMEOUT' && typeof t.timeout === 'number' ? Math.round(t.timeout * 1000) : undefined
    const actions = (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []) as Rec[]
    for (const a of actions.slice(0, 1)) {
      const base: Rec = { trigger, ...(timeout !== undefined ? { timeout } : {}) }
      if (a.type === 'BACK') out.push({ ...base, action: 'BACK' } as CloneReaction)
      else if (a.type === 'CLOSE') out.push({ ...base, action: 'CLOSE_OVERLAY' } as CloneReaction)
      else if (a.type === 'URL' && typeof a.url === 'string') out.push({ ...base, action: 'URL', url: a.url } as CloneReaction)
      else if (a.type === 'NODE' && typeof a.destinationId === 'string') {
        const tr = (a.transition ?? null) as Rec | null
        const kind = tr ? pick(tr.type, TRANSITIONS) : undefined
        const easing = tr && tr.easing ? pick((tr.easing as Rec).type, EASINGS) : undefined
        out.push({
          ...base,
          action: a.navigation === 'OVERLAY' || a.navigation === 'SWAP' ? 'OVERLAY' : 'NAVIGATE',
          destinationId: a.destinationId,
          transition: kind ?? 'INSTANT',
          ...(kind && tr && pick(tr.direction, ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'] as const) ? { direction: tr.direction } : {}),
          ...(kind && tr && typeof tr.duration === 'number' ? { duration: Math.round((tr.duration as number) * 1000) } : {}),
          ...(easing ? { easing } : {}),
        } as CloneReaction)
      }
    }
  }
  return out
}

/** This file's reactions in Figma's shape. */
export function reactionsToFigma(list: CloneReaction[] | undefined): Rec[] {
  return (list ?? []).map((r) => {
    const trigger: Rec = { type: r.trigger === 'ON_HOVER' ? 'ON_HOVER' : r.trigger, ...(r.trigger === 'AFTER_TIMEOUT' ? { timeout: (r.timeout ?? 800) / 1000 } : {}) }
    const action: Rec =
      r.action === 'BACK'
        ? { type: 'BACK' }
        : r.action === 'CLOSE_OVERLAY'
          ? { type: 'CLOSE' }
          : r.action === 'URL'
            ? { type: 'URL', url: r.url }
            : {
                type: 'NODE',
                destinationId: r.destinationId ?? null,
                navigation: r.action === 'OVERLAY' ? 'OVERLAY' : 'NAVIGATE',
                transition:
                  !r.transition || r.transition === 'INSTANT'
                    ? null
                    : { type: r.transition, direction: r.direction ?? 'LEFT', duration: (r.duration ?? 300) / 1000, easing: { type: r.easing ?? 'EASE_OUT' }, matchLayers: false },
                preserveScrollPosition: false,
              }
    return { trigger, actions: [action] }
  })
}

function effectsFromFigma(list: unknown): Effect[] {
  if (!Array.isArray(list)) throw new Error('effects must be an array')
  return list.map((raw) => {
    const e = raw as Rec
    const vis = e.visible === false ? { visible: false } : {}
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const c = (e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }) as { r: number; g: number; b: number; a?: number } | string
      const off = (e.offset ?? { x: e.x ?? 0, y: e.y ?? 0 }) as { x: number; y: number }
      return { type: e.type, color: toHex(c), opacity: typeof c === 'object' ? (c.a ?? 1) : ((e.opacity as number) ?? 1), x: off.x, y: off.y, blur: (e.radius ?? e.blur ?? 0) as number, spread: (e.spread ?? 0) as number, ...vis } as Effect
    }
    return { type: e.type === 'BACKGROUND_BLUR' ? 'BACKGROUND_BLUR' : 'LAYER_BLUR', radius: (e.radius ?? 0) as number, ...vis } as Effect
  })
}

function effectsToFigma(list: Effect[] | undefined): Rec[] {
  return (list ?? []).map((e) =>
    e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'
      ? { type: e.type, color: { ...toRgb(e.color), a: e.opacity ?? 1 }, offset: { x: e.x, y: e.y }, radius: e.blur, spread: e.spread ?? 0, visible: e.visible !== false, blendMode: 'NORMAL' }
      : { type: e.type, radius: (e as { radius: number }).radius, visible: e.visible !== false },
  )
}

/** Properties stored under the same name and shape in both APIs. */
const DIRECT = new Set([
  'name', 'x', 'y', 'opacity', 'visible', 'locked', 'blendMode', 'isMask', 'clipsContent', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight',
  'paddingTop', 'paddingBottom', 'primaryAxisAlignItems', 'layoutMode', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'strokeWeight',
  'strokeAlign', 'dashPattern', 'strokeCap', 'pointCount', 'characters', 'fontSize', 'textAlignHorizontal', 'textAlignVertical', 'textDecoration', 'textCase',
  'constraints', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'description', 'fillStyleId', 'strokeStyleId', 'textStyleId', 'layoutGrids',
  'constrainProportions', 'arrowStart', 'arrowEnd', 'overflowDirection', 'scrollBehavior', 'overlayPositionType', 'overlayBackgroundInteraction',
])
const NULLABLE = new Set(['minWidth', 'maxWidth', 'minHeight', 'maxHeight'])
const IGNORED = new Set(['expanded', 'exportSettings', 'strokeMiterLimit', 'strokeJoin', 'relativeTransform', 'paragraphSpacing', 'paragraphIndent', 'listSpacing', 'hangingPunctuation', 'hangingList', 'leadingTrim', 'strokesIncludedInLayout', 'itemReverseZIndex', 'cornerSmoothing', 'effectStyleId', 'gridStyleId', 'targetAspectRatio', 'annotations', 'devStatus', 'guides', 'numberOfFixedChildren', 'counterAxisAlignContent', 'layoutAlign2', 'fontKerning', 'openTypeFeatures', 'hyperlink', 'textTruncation', 'maxLines'])

export async function runFigmaCodeInline(
  code: string,
  pages: PageModel[],
  currentPageId: string,
  styles: StyleModel[],
  fileName: string,
): Promise<RunResult> {
  const logs: string[] = []
  const warnings = new Set<string>()
  let current = pages.find((p) => p.pageId === currentPageId) ?? pages[0]
  let selection: RunResult['selection'] = null
  const warn = (m: string) => warnings.add(m)

  const pageOf = new Map<string, PageModel>()
  const byId = new Map<string, SceneNode>()
  for (const p of pages)
    for (const n of p.nodes) {
      byId.set(n.id, n)
      pageOf.set(n.id, p)
    }
  // Children of every layer (and of each page, under rootKey), kept up to date as the script edits the tree, so
  // appending or looking up children never rescans the page: a generator making thousands of layers stays linear.
  const kidIds = new Map<string, string[]>()
  const rootKey = (page: PageModel) => `\u0000page:${page.pageId}`
  const keyOf = (n: SceneNode) => (n.parentId && byId.has(n.parentId) ? n.parentId : rootKey(pageOf.get(n.id)!))
  const listAt = (key: string) => {
    let l = kidIds.get(key)
    if (!l) kidIds.set(key, (l = []))
    return l
  }
  for (const p of pages) for (const n of p.nodes) listAt(keyOf(n)).push(n.id)
  for (const l of kidIds.values()) l.sort((a, b) => byId.get(a)!.order - byId.get(b)!.order || (a < b ? -1 : 1))
  const unlist = (n: SceneNode) => {
    const l = kidIds.get(keyOf(n))
    const i = l ? l.indexOf(n.id) : -1
    if (i >= 0) l!.splice(i, 1)
  }
  /** Layers removed by the script, dropped from page.nodes in one pass instead of one scan per removal. */
  const removedIds = new Set<string>()
  const compact = (page: PageModel) => {
    if (removedIds.size) page.nodes = page.nodes.filter((x) => !removedIds.has(x.id))
  }
  const childrenOf = (page: PageModel, parentId: string | undefined): SceneNode[] => (kidIds.get(parentId ?? rootKey(page)) ?? []).map((id) => byId.get(id)!)
  /** A live index of one page over the kept child lists (only `get` is used by the tree helpers). */
  const indexOf = (page: PageModel): DocIndex => ({
    byId,
    children: { get: (k: string) => kidIds.get(k === '' ? rootKey(page) : k) } as unknown as DocIndex['children'],
  })

  const wrappers = new Map<string, object>()
  const pageWrappers = new Map<string, object>()
  const unwrap = (v: unknown): SceneNode => {
    const id = (v as { id?: string } | null)?.id
    const n = id ? byId.get(id) : undefined
    if (!n) throw new Error('Expected a node that still exists in the document')
    return n
  }

  /**
   * Edits a script makes to an instance or the layers inside it (text, fills, visibility, …) become overrides, as in
   * Figma: whatever now differs from the component's own layer is recorded, so syncing the instance keeps it.
   */
  function recordOverrides() {
    for (const n of byId.values()) {
      const mainId = n.sourceId ?? (n.componentId && !n.sourceId ? n.componentId : undefined)
      const main = mainId ? byId.get(mainId) : undefined
      if (!main || main === n) continue
      const a = n as unknown as Rec
      const b = main as unknown as Rec
      const patch: Rec = {}
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) patch[k] = a[k]
      const keys = overrideKeys(n, patch)
      if (!keys.length) continue
      const set = new Set([...(n.overrides ?? []), ...keys])
      if (set.size !== (n.overrides ?? []).length) n.overrides = [...set]
    }
  }
  // Auto layout runs when a script reads geometry, as in Figma: a frame set to fill its parent reports its real width
  // once the parent is laid out. Every edit bumps `edits`; a layout root is laid out again only after an edit.
  let edits = 0
  const laidOutAt = new Map<string, number>()
  /** The frame whose layout decides this node's geometry: climb while the parent is an auto-layout frame. */
  const layoutRoot = (n: SceneNode): SceneNode => {
    let cur = n
    for (let guard = 0; guard < 1000; guard++) {
      const p = cur.parentId ? byId.get(cur.parentId) : undefined
      if (!p || !isAutoLayout(p)) break
      cur = p
    }
    return cur
  }
  function ensureLayout(n: SceneNode) {
    const root = layoutRoot(n)
    if (laidOutAt.get(root.id) === edits) return
    const page = pageOf.get(root.id)
    if (!page) return
    const sub = [root, ...descendants(indexOf(page), root.id).map((id) => byId.get(id)!)]
    // Laid out on its own: the root keeps its place, and its children are placed inside it.
    const res = runLayout(sub.map((x, i) => (i === 0 ? { ...x, parentId: undefined } : x)), estimateMeasure)
    for (const { id, patch } of res.patches) Object.assign(byId.get(id)!, patch)
    laidOutAt.set(root.id, edits)
  }
  const GEOMETRY_READS = new Set(['x', 'y', 'width', 'height', 'absoluteBoundingBox', 'absoluteRenderBounds', 'absoluteTransform', 'relativeTransform'])

  /** A new id no layer in the file uses yet. */
  function freshId(): string {
    let id = newId()
    while (byId.has(id)) id = newId()
    return id
  }
  function add(page: PageModel, n: SceneNode) {
    edits++
    page.nodes.push(n)
    byId.set(n.id, n)
    pageOf.set(n.id, page)
    removedIds.delete(n.id)
    listAt(keyOf(n)).push(n.id)
  }
  function removeNode(n: SceneNode) {
    edits++
    const page = pageOf.get(n.id)!
    const gone = [n.id, ...descendants(indexOf(page), n.id)]
    unlist(n)
    for (const id of gone) {
      kidIds.delete(id)
      byId.delete(id)
      pageOf.delete(id)
      removedIds.add(id)
    }
  }
  /** True if `id` is `of` or lies inside it, found by walking up from `id`. */
  const within = (id: string, of: string) => {
    for (let cur: string | undefined = id, guard = 0; cur && guard < 10000; cur = byId.get(cur)?.parentId, guard++) if (cur === of) return true
    return false
  }
  function attach(n: SceneNode, page: PageModel, parentId: string | undefined, index?: number) {
    edits++
    const from = pageOf.get(n.id)!
    if (parentId && within(parentId, n.id)) throw new Error('Cannot append a node to itself or its own descendant')
    unlist(n)
    if (from !== page) {
      compact(from)
      const ids = new Set([n.id, ...descendants(indexOf(from), n.id)])
      const moving = from.nodes.filter((x) => ids.has(x.id))
      from.nodes = from.nodes.filter((x) => !ids.has(x.id))
      page.nodes.push(...moving)
      for (const m of moving) pageOf.set(m.id, page)
    }
    if (parentId) n.parentId = parentId
    else delete n.parentId
    const siblings = listAt(keyOf(n))
    const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length))
    siblings.splice(at, 0, n.id)
    siblings.forEach((id, i) => (byId.get(id)!.order = i))
    applyChildFlags(n)
  }
  /** layoutGrow / layoutAlign depend on the parent's direction, so they are resolved once the node has a parent. */
  function applyChildFlags(n: SceneNode) {
    const f = flags.get(n.id)
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    if (!f || !parent || !parent.layoutMode || parent.layoutMode === 'NONE') return
    const horiz = parent.layoutMode === 'HORIZONTAL'
    if (f.grow !== undefined) {
      const key = horiz ? 'layoutSizingHorizontal' : 'layoutSizingVertical'
      if (f.grow) n[key] = 'FILL'
      else if (n[key] === 'FILL') n[key] = 'FIXED'
    }
    if (f.stretch !== undefined) {
      const key = horiz ? 'layoutSizingVertical' : 'layoutSizingHorizontal'
      if (f.stretch) n[key] = 'FILL'
      else if (n[key] === 'FILL') n[key] = 'FIXED'
    }
    if (n.type === 'TEXT' && n.layoutSizingHorizontal === 'FILL' && (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT') n.textAutoResize = 'HEIGHT'
  }
  const flags = new Map<string, { grow?: boolean; stretch?: boolean }>()

  function create(type: NodeType, props: Partial<SceneNode> = {}): SceneNode {
    const n = { id: freshId(), order: 0, type, name: props.name ?? type[0] + type.slice(1).toLowerCase(), x: 0, y: 0, width: 100, height: 100, ...defaultsFor(type), ...props } as SceneNode
    add(current, n)
    attach(n, current, undefined)
    return n
  }
  function cloneTree(src: SceneNode, asInstance: boolean): SceneNode {
    const page = pageOf.get(src.id)!
    const ix = indexOf(page)
    const ids = [src.id, ...descendants(ix, src.id)]
    const map = new Map(ids.map((id) => [id, freshId()]))
    let root!: SceneNode
    for (const id of ids) {
      const o = byId.get(id)!
      const c = structuredClone(o)
      c.id = map.get(id)!
      if (o.parentId && map.has(o.parentId)) c.parentId = map.get(o.parentId)
      if (asInstance) {
        if (id === src.id) {
          delete c.isComponent
          delete c.description
          c.componentId = src.id
        } else {
          c.sourceId = id
          delete c.overrides
        }
      }
      add(asInstance ? current : page, c)
      if (id === src.id) root = c
    }
    if (asInstance) {
      root.x = 0
      root.y = 0
      attach(root, current, undefined)
    } else attach(root, page, src.parentId)
    return root
  }
  function wrapGroup(nodesIn: unknown[], parent: unknown, type: NodeType, props: Partial<SceneNode>): SceneNode {
    const list = nodesIn.map(unwrap)
    if (!list.length) throw new Error('Need at least one node')
    const page = pageOf.get(list[0].id)!
    const parentId = parent && (parent as { type?: string }).type !== 'PAGE' ? unwrap(parent).id : undefined
    const ix = indexOf(page)
    const pw = parentId ? worldMatrix(ix, parentId) : [1, 0, 0, 1, 0, 0]
    const boxes = list.map((n) => boundsOf(corners(worldMatrix(ix, n.id), n.width, n.height)))
    const minX = Math.min(...boxes.map((b) => b.x)) - pw[4]
    const minY = Math.min(...boxes.map((b) => b.y)) - pw[5]
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) - pw[4]
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) - pw[5]
    const g = { id: freshId(), order: 0, type, name: props.name ?? 'Group', x: minX, y: minY, width: maxX - minX, height: maxY - minY, ...props } as SceneNode
    add(page, g)
    attach(g, page, parentId)
    list.forEach((n, i) => {
      const b = boxes[i]
      attach(n, page, g.id)
      if (!n.rotation) {
        n.x = b.x - pw[4] - minX
        n.y = b.y - pw[5] - minY
      }
    })
    return g
  }

  const figType = (n: SceneNode) => (n.isSection ? 'SECTION' : n.isComponentSet ? 'COMPONENT_SET' : n.isComponent ? 'COMPONENT' : n.componentId ? 'INSTANCE' : n.booleanOp ? 'BOOLEAN_OPERATION' : n.type)

  const methods: Record<string, (n: SceneNode) => unknown> = {
    appendChild: (n) => (child: unknown) => attach(unwrap(child), pageOf.get(n.id)!, n.id),
    insertChild: (n) => (index: number, child: unknown) => attach(unwrap(child), pageOf.get(n.id)!, n.id, index),
    remove: (n) => () => removeNode(n),
    clone: (n) => () => wrap(cloneTree(n, false)),
    resize: (n) => (w: number, h: number) => {
      n.width = Math.max(n.type === 'LINE' ? 0 : 0.01, w)
      n.height = n.type === 'LINE' ? 0 : Math.max(0.01, h)
      if (n.layoutSizingHorizontal === 'HUG') n.layoutSizingHorizontal = 'FIXED'
      if (n.layoutSizingVertical === 'HUG') n.layoutSizingVertical = 'FIXED'
      if (n.type === 'TEXT') n.textAutoResize = 'NONE'
    },
    resizeWithoutConstraints: (n) => (w: number, h: number) => (methods.resize(n) as (w: number, h: number) => void)(w, h),
    rescale: (n) => (s: number) => (methods.resize(n) as (w: number, h: number) => void)(n.width * s, n.height * s),
    findAll: (n) => (cb?: (x: unknown) => boolean) => descendants(indexOf(pageOf.get(n.id)!), n.id).map((id) => wrap(byId.get(id)!)).filter((w) => !cb || cb(w)),
    findOne: (n) => (cb: (x: unknown) => boolean) => descendants(indexOf(pageOf.get(n.id)!), n.id).map((id) => wrap(byId.get(id)!)).find((w) => cb(w)) ?? null,
    findChildren: (n) => (cb?: (x: unknown) => boolean) => childrenOf(pageOf.get(n.id)!, n.id).map(wrap).filter((w) => !cb || cb(w)),
    findChild: (n) => (cb: (x: unknown) => boolean) => childrenOf(pageOf.get(n.id)!, n.id).map(wrap).find((w) => cb(w)) ?? null,
    findAllWithCriteria: (n) => (c: { types?: string[] }) => descendants(indexOf(pageOf.get(n.id)!), n.id).map((id) => byId.get(id)!).filter((x) => !c.types || c.types.includes(figType(x))).map(wrap),
    createInstance: (n) => () => {
      if (!n.isComponent) throw new Error('createInstance() is only available on COMPONENT nodes')
      return wrap(cloneTree(n, true))
    },
    detachInstance: (n) => () => {
      delete n.componentId
      delete n.overrides
      for (const id of descendants(indexOf(pageOf.get(n.id)!), n.id)) {
        delete byId.get(id)!.sourceId
        delete byId.get(id)!.overrides
      }
      return wrap(n)
    },
    getMainComponentAsync: (n) => async () => (n.componentId && byId.has(n.componentId) ? wrap(byId.get(n.componentId)!) : null),
    swapComponent: (n) => (c: unknown) => {
      n.componentId = unwrap(c).id
      delete n.overrides
    },
    setFillStyleIdAsync: (n) => async (id: string) => void (n.fillStyleId = id || undefined),
    setStrokeStyleIdAsync: (n) => async (id: string) => void (n.strokeStyleId = id || undefined),
    setTextStyleIdAsync: (n) => async (id: string) => void (n.textStyleId = id || undefined),
    // An effect style's shadows and blurs are copied onto the layer (effect styles are not saved as shared styles).
    setEffectStyleIdAsync: (n) => async (id: string) => {
      const st = styles.find((x) => x.id === id && x.kind === 'EFFECT' && !x.removed)
      if (st) n.effects = structuredClone(st.value.effects ?? [])
    },
    // Plugin data is stored on the layer, so a generator can find and replace what it made on its next run.
    getPluginData: (n) => (k: string) => n.pluginData?.[k] ?? '',
    setPluginData: (n) => (k: string, v: string) => {
      const next = { ...n.pluginData }
      if (v === '' || v == null) delete next[k]
      else next[k] = String(v)
      n.pluginData = Object.keys(next).length ? next : undefined
    },
    getPluginDataKeys: (n) => () => Object.keys(n.pluginData ?? {}),
    getSharedPluginData: (n) => (ns: string, k: string) => n.sharedPluginData?.[ns]?.[k] ?? '',
    setSharedPluginData: (n) => (ns: string, k: string, v: string) => {
      const space = { ...n.sharedPluginData?.[ns] }
      if (v === '' || v == null) delete space[k]
      else space[k] = String(v)
      const all = { ...n.sharedPluginData, [ns]: space }
      if (!Object.keys(space).length) delete all[ns]
      n.sharedPluginData = Object.keys(all).length ? all : undefined
    },
    getSharedPluginDataKeys: (n) => (ns: string) => Object.keys(n.sharedPluginData?.[ns] ?? {}),
    setRelaunchData: () => () => {},
    setReactionsAsync: (n) => async (v: unknown) => {
      const list = reactionsFromFigma(v)
      if (list.length) n.reactions = list
      else delete n.reactions
    },
    exportAsync: () => async () => {
      throw new Error('exportAsync is not available here — use the get_screenshot / download_assets / export_image tools instead')
    },
    toString: (n: SceneNode) => () => `[Node ${figType(n)} ${n.id}]`,
    toJSON: (n) => () => ({ id: n.id, name: n.name, type: figType(n) }),
  }
  const range =
    (key: keyof TextRunStyle, conv: (v: unknown, n: SceneNode) => TextRunStyle) =>
    (n: SceneNode) =>
    (start: number, end: number, value: unknown) => {
      const runs = styleRange(n, start, end, conv(value, n))
      if (runs.length) n.textRuns = runs
      else delete n.textRuns
      void key
    }
  const fontFromName = (v: unknown): TextRunStyle => {
    const f = v as { family: string; style?: string }
    const style = (f.style ?? 'Regular').toLowerCase()
    const italic = /italic|oblique/.test(style)
    const w = WEIGHTS[style.replace(/\s*(italic|oblique)\s*/, '').trim() || 'regular'] ?? 400
    return { fontFamily: f.family, fontWeight: w, italic }
  }
  methods.setRangeFontSize = range('fontSize', (v) => ({ fontSize: v as number }))
  methods.setRangeFontName = range('fontFamily', fontFromName)
  methods.setRangeFills = range('fills', (v) => ({ fills: paintsFromFigma(v) }))
  methods.setRangeTextDecoration = range('textDecoration', (v) => ({ textDecoration: v as 'NONE' }))
  methods.setRangeLetterSpacing = range('letterSpacing', (v, n) => {
    const l = v as { value: number; unit?: string }
    return { letterSpacing: l.unit === 'PERCENT' ? ((n.fontSize ?? 12) * l.value) / 100 : l.value }
  })
  for (const m of ['setRangeTextCase', 'setRangeLineHeight', 'setRangeHyperlink', 'setRangeListOptions', 'setRangeIndentation', 'setRangeTextStyleIdAsync', 'setRangeFillStyleIdAsync', 'insertCharacters', 'deleteCharacters'])
    methods[m] ??= () => () => warn(`${m} is not supported`)
  methods.insertCharacters = (n) => (start: number, chars: string) => void (n.characters = (n.characters ?? '').slice(0, start) + chars + (n.characters ?? '').slice(start))
  methods.deleteCharacters = (n) => (start: number, end: number) => void (n.characters = (n.characters ?? '').slice(0, start) + (n.characters ?? '').slice(end))

  const getters: Record<string, (n: SceneNode) => unknown> = {
    id: (n) => n.id,
    type: (n) => figType(n),
    removed: (n) => !byId.has(n.id),
    width: (n) => n.width,
    height: (n) => n.height,
    rotation: (n) => -(n.rotation ?? 0),
    parent: (n) => (n.parentId && byId.has(n.parentId) ? wrap(byId.get(n.parentId)!) : wrapPage(pageOf.get(n.id)!)),
    children: (n) => childrenOf(pageOf.get(n.id)!, n.id).map(wrap),
    fills: (n) => paintsToFigma(n.fills),
    strokes: (n) => paintsToFigma(n.strokes),
    effects: (n) => effectsToFigma(n.effects),
    cornerRadius: (n) => (n.cornerRadii ? mixed : (n.cornerRadius ?? 0)),
    topLeftRadius: (n) => n.cornerRadii?.[0] ?? n.cornerRadius ?? 0,
    topRightRadius: (n) => n.cornerRadii?.[1] ?? n.cornerRadius ?? 0,
    bottomRightRadius: (n) => n.cornerRadii?.[2] ?? n.cornerRadius ?? 0,
    bottomLeftRadius: (n) => n.cornerRadii?.[3] ?? n.cornerRadius ?? 0,
    fontName: (n) => ({ family: n.fontFamily ?? 'Inter', style: WEIGHT_NAMES[n.fontWeight ?? 400] + (n.italic ? ' Italic' : '') }),
    fontWeight: (n) => n.fontWeight ?? 400,
    lineHeight: (n) => (n.lineHeight == null ? { unit: 'AUTO' } : { value: n.lineHeight, unit: 'PIXELS' }),
    letterSpacing: (n) => ({ value: n.letterSpacing ?? 0, unit: 'PIXELS' }),
    textAutoResize: (n) => n.textAutoResize ?? 'WIDTH_AND_HEIGHT',
    counterAxisAlignItems: (n) => n.counterAxisAlignItems ?? 'MIN',
    layoutWrap: (n) => (n.layoutWrap ? 'WRAP' : 'NO_WRAP'),
    layoutGrow: (n) => {
      const p = n.parentId ? byId.get(n.parentId) : undefined
      return p && (p.layoutMode === 'HORIZONTAL' ? n.layoutSizingHorizontal : n.layoutSizingVertical) === 'FILL' ? 1 : 0
    },
    layoutAlign: (n) => {
      const p = n.parentId ? byId.get(n.parentId) : undefined
      return p && (p.layoutMode === 'HORIZONTAL' ? n.layoutSizingVertical : n.layoutSizingHorizontal) === 'FILL' ? 'STRETCH' : 'INHERIT'
    },
    primaryAxisSizingMode: (n) => ((n.layoutMode === 'HORIZONTAL' ? n.layoutSizingHorizontal : n.layoutSizingVertical) === 'HUG' ? 'AUTO' : 'FIXED'),
    counterAxisSizingMode: (n) => ((n.layoutMode === 'HORIZONTAL' ? n.layoutSizingVertical : n.layoutSizingHorizontal) === 'HUG' ? 'AUTO' : 'FIXED'),
    innerRadius: (n) => n.starInnerRadius ?? 0.382,
    booleanOperation: (n) => n.booleanOp,
    vectorPaths: (n) => [{ windingRule: n.vectorFillRule === 'evenodd' ? 'EVENODD' : 'NONZERO', data: n.vectorPath ?? '' }],
    reactions: (n) => reactionsToFigma(n.reactions),
    overlayBackground: (n) =>
      !n.overlayBackground || n.overlayBackground.type === 'NONE' ? { type: 'NONE' } : { type: 'SOLID_COLOR', color: { ...toRgb(n.overlayBackground.color), a: n.overlayBackground.opacity ?? 1 } },
    mainComponent: (n) => (n.componentId && byId.has(n.componentId) ? wrap(byId.get(n.componentId)!) : null),
    key: (n) => n.id,
    absoluteBoundingBox: (n) => {
      const b = boundsOf(corners(worldMatrix(indexOf(pageOf.get(n.id)!), n.id), n.width, n.height))
      return { x: b.x, y: b.y, width: b.w, height: b.h }
    },
    absoluteRenderBounds: (n) => getters.absoluteBoundingBox(n),
    absoluteTransform: (n) => {
      const m = worldMatrix(indexOf(pageOf.get(n.id)!), n.id)
      return [
        [m[0], m[2], m[4]],
        [m[1], m[3], m[5]],
      ]
    },
  }

  const setters: Record<string, (n: SceneNode, v: never) => void> = {
    reactions: (n, v: unknown) => {
      const list = reactionsFromFigma(v)
      if (list.length) n.reactions = list
      else delete n.reactions
    },
    overlayBackground: (n, v: Rec | null) => {
      if (!v || v.type !== 'SOLID_COLOR') n.overlayBackground = { type: 'NONE' }
      else {
        const c = (v.color ?? {}) as Rec
        n.overlayBackground = typeof c === 'string' ? { type: 'SOLID_COLOR', color: c } : { type: 'SOLID_COLOR', color: toHex(c as { r: number; g: number; b: number }), opacity: typeof c.a === 'number' ? c.a : 1 }
      }
    },
    rotation: (n, v: number) => void (v ? (n.rotation = -v) : delete n.rotation),
    fills: (n, v) => void (n.fills = paintsFromFigma(v)),
    strokes: (n, v) => {
      n.strokes = paintsFromFigma(v)
      if (n.strokes.length && n.strokeWeight === undefined) n.strokeWeight = 1
    },
    effects: (n, v) => void (n.effects = effectsFromFigma(v)),
    cornerRadius: (n, v: number) => {
      n.cornerRadius = v
      delete n.cornerRadii
    },
    fontName: (n, v) => void Object.assign(n, fontFromName(v)),
    fontWeight: (n, v: number) => void (n.fontWeight = v),
    lineHeight: (n, v: { value?: number; unit?: string } | number) => {
      if (typeof v === 'number') n.lineHeight = v
      else if (!v || v.unit === 'AUTO') delete n.lineHeight
      else n.lineHeight = v.unit === 'PERCENT' ? ((n.fontSize ?? 12) * (v.value ?? 100)) / 100 : v.value
    },
    letterSpacing: (n, v: { value: number; unit?: string } | number) => void (n.letterSpacing = typeof v === 'number' ? v : v.unit === 'PERCENT' ? ((n.fontSize ?? 12) * v.value) / 100 : v.value),
    textAutoResize: (n, v: string) => void (n.textAutoResize = v === 'TRUNCATE' ? 'NONE' : (v as 'NONE')),
    counterAxisAlignItems: (n, v: string) => void (n.counterAxisAlignItems = v as 'MIN'),
    layoutWrap: (n, v: string) => void (v === 'WRAP' ? (n.layoutWrap = true) : delete n.layoutWrap),
    layoutGrow: (n, v: number) => {
      flags.set(n.id, { ...flags.get(n.id), grow: v > 0 })
      applyChildFlags(n)
    },
    layoutAlign: (n, v: string) => {
      flags.set(n.id, { ...flags.get(n.id), stretch: v === 'STRETCH' })
      applyChildFlags(n)
    },
    primaryAxisSizingMode: (n, v: string) => void (n[n.layoutMode === 'VERTICAL' ? 'layoutSizingVertical' : 'layoutSizingHorizontal'] = v === 'AUTO' ? 'HUG' : 'FIXED'),
    counterAxisSizingMode: (n, v: string) => void (n[n.layoutMode === 'VERTICAL' ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] = v === 'AUTO' ? 'HUG' : 'FIXED'),
    innerRadius: (n, v: number) => void (n.starInnerRadius = v),
    booleanOperation: (n, v: 'UNION') => void (n.booleanOp = v),
    vectorPaths: (n, v: { windingRule?: string; data: string }[]) => {
      n.vectorPath = v.map((p) => p.data).join(' ')
      if (v.some((p) => p.windingRule === 'EVENODD')) n.vectorFillRule = 'evenodd'
      n.vectorWidth = n.width
      n.vectorHeight = n.height
    },
    layoutMode: (n, v: 'NONE') => {
      const was = n.layoutMode && n.layoutMode !== 'NONE'
      n.layoutMode = v
      // Like Figma, a frame that gains auto layout hugs its content until told otherwise.
      if (v !== 'NONE' && !was) {
        n.layoutSizingHorizontal ??= 'HUG'
        n.layoutSizingVertical ??= 'HUG'
      }
    },
  }
  for (const [k, i] of [['topLeftRadius', 0], ['topRightRadius', 1], ['bottomRightRadius', 2], ['bottomLeftRadius', 3]] as const)
    setters[k] = (n: SceneNode, v: number) => {
      const r = [...(n.cornerRadii ?? [n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0])] as [number, number, number, number]
      r[i] = v
      n.cornerRadii = r
    }

  const mixed = Symbol('figma.mixed')

  function wrap(n: SceneNode): object {
    let w = wrappers.get(n.id)
    if (w) return w
    const id = n.id
    const live = () => {
      const cur = byId.get(id)
      if (!cur) throw new Error(`Node ${id} was removed`)
      return cur
    }
    w = new Proxy(
      {},
      {
        get(_t, key) {
          if (typeof key === 'symbol') return undefined
          if (key === 'id') return id
          if (key === 'removed') return !byId.has(id)
          if (key === 'then') return undefined
          const cur = live()
          if (GEOMETRY_READS.has(key)) ensureLayout(cur)
          if (Object.hasOwn(methods, key)) {
            edits++
            return methods[key](cur)
          }
          if (Object.hasOwn(getters, key)) return getters[key](cur)
          if (DIRECT.has(key)) return (cur as unknown as Rec)[key] ?? (key === 'visible' ? true : key === 'opacity' ? 1 : key === 'locked' || key === 'isMask' ? false : NULLABLE.has(key) ? null : (cur as unknown as Rec)[key])
          return undefined
        },
        set(_t, key, value) {
          if (typeof key === 'symbol') return true
          edits++
          const cur = live()
          if (key === 'width' || key === 'height') throw new Error(`"${key}" is read-only — use node.resize(width, height)`)
          if (Object.hasOwn(setters, key)) setters[key](cur, value as never)
          else if (DIRECT.has(key)) {
            if (value === undefined || (value === null && NULLABLE.has(key)) || (key === 'visible' && value === true) || (key === 'locked' && value === false)) delete (cur as unknown as Rec)[key]
            else (cur as unknown as Rec)[key] = value
            if (key === 'characters' && cur.type === 'TEXT' && (cur.name === 'Text' || !cur.name)) cur.name = String(value).split('\n')[0].slice(0, 40) || 'Text'
          } else if (!IGNORED.has(key)) warn(`Property "${key}" is not supported and was ignored`)
          return true
        },
        has: (_t, key) => typeof key === 'string' && (Object.hasOwn(methods, key) || Object.hasOwn(getters, key) || DIRECT.has(key)),
        ownKeys: () => ['id', 'name', 'type'],
        getOwnPropertyDescriptor: (_t, key) => (key === 'id' || key === 'name' || key === 'type' ? { enumerable: true, configurable: true, value: key === 'id' ? id : key === 'name' ? byId.get(id)?.name : byId.get(id) ? figType(byId.get(id)!) : undefined } : undefined),
      },
    )
    wrappers.set(id, w)
    return w
  }

  function wrapPage(p: PageModel): object {
    let w = pageWrappers.get(p.pageId)
    if (w) return w
    const all = () => {
      const ix = indexOf(p)
      const out: SceneNode[] = []
      const walk = (pid: string) => {
        for (const c of kids(ix, pid)) {
          out.push(ix.byId.get(c)!)
          walk(c)
        }
      }
      walk('')
      return out
    }
    w = {
      get id() {
        return p.pageId
      },
      type: 'PAGE',
      get name() {
        return p.name
      },
      set name(v: string) {
        p.name = v
      },
      get children() {
        return childrenOf(p, undefined).map(wrap)
      },
      get parent() {
        return root
      },
      get selection() {
        return (selection?.pageId === p.pageId ? selection.ids : []).filter((id) => byId.has(id)).map((id) => wrap(byId.get(id)!))
      },
      set selection(v: unknown[]) {
        selection = { pageId: p.pageId, ids: v.map((x) => unwrap(x).id) }
      },
      get flowStartingPoints() {
        return all()
          .filter((n) => n.flowStart)
          .map((n) => ({ nodeId: n.id, name: n.flowStart }))
      },
      set flowStartingPoints(v: { nodeId: string; name?: string }[]) {
        edits++
        for (const n of all()) if (n.flowStart) delete n.flowStart
        ;(v ?? []).forEach((f, i) => {
          const n = byId.get(f.nodeId)
          if (n && pageOf.get(n.id) === p) n.flowStart = f.name || `Flow ${i + 1}`
        })
      },
      appendChild: (child: unknown) => attach(unwrap(child), p, undefined),
      insertChild: (index: number, child: unknown) => attach(unwrap(child), p, undefined, index),
      findAll: (cb?: (x: unknown) => boolean) => all().map(wrap).filter((x) => !cb || cb(x)),
      findOne: (cb: (x: unknown) => boolean) => all().map(wrap).find((x) => cb(x)) ?? null,
      findChildren: (cb?: (x: unknown) => boolean) => childrenOf(p, undefined).map(wrap).filter((x) => !cb || cb(x)),
      findChild: (cb: (x: unknown) => boolean) => childrenOf(p, undefined).map(wrap).find((x) => cb(x)) ?? null,
      findAllWithCriteria: (c: { types?: string[] }) => all().filter((x) => !c.types || c.types.includes(figType(x))).map(wrap),
      loadAsync: async () => {},
      toJSON: () => ({ id: p.pageId, name: p.name, type: 'PAGE' }),
    }
    pageWrappers.set(p.pageId, w)
    return w
  }

  /** What a style keeps when its value is replaced. */
  const meta = (s: StyleModel) => (s.value.pluginData ? { pluginData: s.value.pluginData } : {})
  const styleObj = (s: StyleModel) => ({
    get id() {
      return s.id
    },
    get key() {
      return s.id
    },
    type: s.kind,
    get name() {
      return s.name
    },
    set name(v: string) {
      s.name = v
      s.dirty = true
    },
    get paints() {
      return paintsToFigma(s.value.paints)
    },
    set paints(v: unknown) {
      s.value = { ...meta(s), paints: paintsFromFigma(v) }
      s.dirty = true
    },
    get fontSize() {
      return s.value.text?.fontSize
    },
    set fontSize(v: unknown) {
      s.value = { ...meta(s), text: { ...s.value.text, fontSize: v } }
      s.dirty = true
    },
    get fontName() {
      return { family: s.value.text?.fontFamily ?? 'Inter', style: WEIGHT_NAMES[(s.value.text?.fontWeight as number) ?? 400] }
    },
    set fontName(v: unknown) {
      s.value = { ...meta(s), text: { ...s.value.text, ...fontFromName(v) } }
      s.dirty = true
    },
    set lineHeight(v: { value?: number; unit?: string }) {
      s.value = { ...meta(s), text: { ...s.value.text, lineHeight: v?.unit === 'AUTO' ? undefined : v?.value } }
      s.dirty = true
    },
    set letterSpacing(v: { value: number }) {
      s.value = { ...meta(s), text: { ...s.value.text, letterSpacing: v?.value } }
      s.dirty = true
    },
    get effects() {
      return effectsToFigma(s.value.effects)
    },
    set effects(v: unknown) {
      s.value = { ...meta(s), effects: effectsFromFigma(v) }
      s.dirty = true
    },
    get description() {
      return ''
    },
    set description(_v: string) {},
    getPluginData: (k: string) => s.value.pluginData?.[k] ?? '',
    setPluginData: (k: string, v: string) => {
      s.value = { ...s.value, pluginData: { ...s.value.pluginData, [k]: String(v) } }
      s.dirty = true
    },
    getPluginDataKeys: () => Object.keys(s.value.pluginData ?? {}),
    getSharedPluginData: (ns: string, k: string) => s.value.pluginData?.[`${ns}:${k}`] ?? '',
    setSharedPluginData: (ns: string, k: string, v: string) => {
      s.value = { ...s.value, pluginData: { ...s.value.pluginData, [`${ns}:${k}`]: String(v) } }
      s.dirty = true
    },
    get removed() {
      return !!s.removed
    },
    remove: () => {
      s.removed = true
    },
  })
  const live = () => styles.filter((x) => !x.removed)
  const newStyle = (kind: 'PAINT' | 'TEXT' | 'EFFECT') => {
    if (kind === 'EFFECT') warn('Effect styles are applied to layers but not saved as shared styles in this file')
    const s: StyleModel = {
      id: `new-style:${freshId()}`,
      kind,
      name: kind === 'PAINT' ? 'Color style' : kind === 'TEXT' ? 'Text style' : 'Effect style',
      value: kind === 'PAINT' ? { paints: [] } : kind === 'TEXT' ? { text: {} } : { effects: [] },
      isNew: true,
    }
    styles.push(s)
    return styleObj(s)
  }

  const root = {
    type: 'DOCUMENT',
    name: fileName,
    get children() {
      return pages.map(wrapPage)
    },
    findAll: (cb?: (x: unknown) => boolean) => pages.flatMap((p) => (wrapPage(p) as { findAll: (cb?: (x: unknown) => boolean) => unknown[] }).findAll(cb)),
    findOne: (cb: (x: unknown) => boolean) => {
      for (const p of pages) {
        const hit = (wrapPage(p) as { findOne: (cb: (x: unknown) => boolean) => unknown }).findOne(cb)
        if (hit) return hit
      }
      return null
    },
  }
  const unsupported = (what: string, instead: string) => () => {
    throw new Error(`${what} is not supported in this file. ${instead}`)
  }
  const boolean = (op: 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE') => (list: unknown[], parent: unknown) => {
    const base = unwrap(list[0])
    return wrap(wrapGroup(list, parent, 'GROUP', { booleanOp: op, name: op[0] + op.slice(1).toLowerCase(), fills: base.fills?.length ? base.fills : [{ type: 'SOLID', color: '#D9D9D9' }] }))
  }
  const getNode = (id: string) => {
    const page = pages.find((p) => p.pageId === id)
    if (page) return wrapPage(page)
    const n = byId.get(id)
    return n ? wrap(n) : null
  }

  const figma = {
    mixed,
    root,
    editorType: 'figma',
    fileKey: undefined,
    get currentPage() {
      return wrapPage(current)
    },
    set currentPage(_v: unknown) {
      throw new Error('Setting figma.currentPage is not supported — use await figma.setCurrentPageAsync(page)')
    },
    setCurrentPageAsync: async (page: { id: string }) => {
      const p = pages.find((x) => x.pageId === page?.id)
      if (!p) throw new Error('Unknown page')
      current = p
    },
    createPage: () => {
      const p: PageModel = { pageId: `new-page:${freshId()}`, name: `Page ${pages.length + 1}`, nodes: [], isNew: true }
      pages.push(p)
      return wrapPage(p)
    },
    getNodeById: getNode,
    getNodeByIdAsync: async (id: string) => getNode(id),
    createFrame: () => wrap(create('FRAME', { name: 'Frame' })),
    createSection: () => wrap(create('FRAME', { name: 'Section', isSection: true, clipsContent: false, cornerRadius: 2, fills: [{ type: 'SOLID', color: '#F5F5F5' }] })),
    createRectangle: () => wrap(create('RECTANGLE', { name: 'Rectangle' })),
    createEllipse: () => wrap(create('ELLIPSE', { name: 'Ellipse' })),
    createLine: () => wrap(create('LINE', { name: 'Line', width: 100, height: 0 })),
    createPolygon: () => wrap(create('POLYGON', { name: 'Polygon' })),
    createStar: () => wrap(create('STAR', { name: 'Star' })),
    createVector: () => wrap(create('VECTOR', { name: 'Vector', vectorPath: '', fills: [] })),
    createText: () => wrap(create('TEXT', { name: 'Text', width: 1, height: 15 })),
    createComponent: () => wrap(create('FRAME', { name: 'Component', isComponent: true })),
    createComponentFromNode: (node: unknown) => {
      const n = unwrap(node)
      if (n.type === 'FRAME' && !n.componentId) {
        n.isComponent = true
        return wrap(n)
      }
      const g = wrapGroup([node], n.parentId ? wrap(byId.get(n.parentId)!) : null, 'FRAME', { name: n.name, isComponent: true, fills: [], clipsContent: false })
      return wrap(g)
    },
    createNodeFromSvg: (svg: string) => {
      const list = svgToNodes(svg)
      if (!list) throw new Error('The SVG has no drawable shapes')
      for (const n of list) add(current, n)
      attach(list[0], current, undefined)
      return wrap(list[0])
    },
    group: (list: unknown[], parent: unknown) => wrap(wrapGroup(list, parent, 'GROUP', {})),
    ungroup: (node: unknown) => {
      const g = unwrap(node)
      const page = pageOf.get(g.id)!
      const out = childrenOf(page, g.id)
      for (const c of out) {
        c.x += g.x
        c.y += g.y
        attach(c, page, g.parentId)
      }
      removeNode(g)
      return out.map(wrap)
    },
    union: boolean('UNION'),
    subtract: boolean('SUBTRACT'),
    intersect: boolean('INTERSECT'),
    exclude: boolean('EXCLUDE'),
    flatten: unsupported('figma.flatten', 'Use a boolean operation (figma.union) or build the shape as one vector path.'),
    combineAsVariants: (list: unknown[], parent: unknown) =>
      wrap(
        wrapGroup(list, parent, 'FRAME', {
          isComponentSet: true,
          name: unwrap(list[0]).name.replace(/=.*$/, '') || 'Component set',
          layoutMode: 'VERTICAL',
          itemSpacing: 20,
          paddingLeft: 20,
          paddingRight: 20,
          paddingTop: 20,
          paddingBottom: 20,
          layoutSizingHorizontal: 'HUG',
          layoutSizingVertical: 'HUG',
          fills: [],
          clipsContent: false,
          strokes: [{ type: 'SOLID', color: '#9747FF' }],
          strokeWeight: 1,
          dashPattern: [6, 4],
          cornerRadius: 5,
        }),
      ),
    loadFontAsync: async () => {},
    listAvailableFontsAsync: async () => ['Inter', 'Roboto', 'Open Sans', 'Poppins', 'Montserrat', 'Playfair Display', 'Roboto Mono'].flatMap((family) => Object.values(WEIGHT_NAMES).map((style) => ({ fontName: { family, style } }))),
    createImage: unsupported('figma.createImage', 'Use await figma.createImageAsync(url) or the upload_assets tool.'),
    createImageAsync: async (url: string) => ({ hash: url, getSizeAsync: async () => ({ width: 0, height: 0 }) }),
    getImageByHash: (hash: string) => ({ hash }),
    getLocalPaintStyles: () => live().filter((s) => s.kind === 'PAINT').map(styleObj),
    getLocalPaintStylesAsync: async () => live().filter((s) => s.kind === 'PAINT').map(styleObj),
    getLocalTextStyles: () => live().filter((s) => s.kind === 'TEXT').map(styleObj),
    getLocalTextStylesAsync: async () => live().filter((s) => s.kind === 'TEXT').map(styleObj),
    getLocalEffectStyles: () => live().filter((s) => s.kind === 'EFFECT').map(styleObj),
    getLocalEffectStylesAsync: async () => live().filter((s) => s.kind === 'EFFECT').map(styleObj),
    getLocalGridStylesAsync: async () => [],
    getStyleById: (id: string) => {
      const s = live().find((x) => x.id === id)
      return s ? styleObj(s) : null
    },
    getStyleByIdAsync: async (id: string) => {
      const s = live().find((x) => x.id === id)
      return s ? styleObj(s) : null
    },
    createPaintStyle: () => newStyle('PAINT'),
    createTextStyle: () => newStyle('TEXT'),
    createEffectStyle: () => newStyle('EFFECT'),
    variables: new Proxy({}, { get: () => unsupported('The variables API', 'Use color / text styles (figma.createPaintStyle, figma.createTextStyle) instead.') }),
    importComponentByKeyAsync: async (key: string) => {
      const n = byId.get(key)
      if (!n?.isComponent) throw new Error(`No local component with key ${key}. To use a component from another file, copy it in first with the import_component tool.`)
      return wrap(n)
    },
    importComponentSetByKeyAsync: async (key: string) => {
      const n = byId.get(key)
      if (!n?.isComponentSet) throw new Error(`No local component set with key ${key}`)
      return wrap(n)
    },
    importStyleByKeyAsync: async (key: string) => {
      const s = styles.find((x) => x.id === key)
      if (!s) throw new Error(`No local style with key ${key}`)
      return styleObj(s)
    },
    notify: (msg: string) => {
      logs.push(`notify: ${msg}`)
      return { cancel() {} }
    },
    closePlugin: (msg?: string) => void (msg && logs.push(`closePlugin: ${msg}`)),
    commitUndo: () => {},
    triggerUndo: () => {},
    viewport: {
      center: { x: 0, y: 0 },
      zoom: 1,
      scrollAndZoomIntoView: (list: unknown[]) => {
        const ids = list.map((x) => unwrap(x).id)
        if (ids.length) selection = { pageId: pageOf.get(ids[0])!.pageId, ids }
      },
    },
    util: {
      rgb: (v: string) => toRgb(v.startsWith('#') ? v : '#' + v),
      rgba: (v: string) => ({ ...toRgb(v.startsWith('#') ? v : '#' + v), a: 1 }),
      solidPaint: (v: string, o?: Rec) => ({ type: 'SOLID', color: toRgb(v.startsWith('#') ? v : '#' + v), ...(o ?? {}) }),
    },
    clientStorage: { getAsync: async () => undefined, setAsync: async () => {}, deleteAsync: async () => {}, keysAsync: async () => [] },
    ui: new Proxy({}, { get: () => () => {} }),
    showUI: () => {},
    on: () => {},
    once: () => {},
    off: () => {},
    currentUser: { id: 'agent', name: 'Agent' },
    loadAllPagesAsync: async () => {},
  }

  const fmt = (v: unknown): string => {
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(plain(v, 0))
    } catch {
      return String(v)
    }
  }
  const plain = (v: unknown, depth: number): unknown => {
    if (v === mixed) return 'figma.mixed'
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? undefined : v
    const id = (v as { id?: unknown }).id
    if (typeof id === 'string' && (byId.has(id) || pages.some((p) => p.pageId === id))) {
      const n = byId.get(id)
      return n ? { id, name: n.name, type: figType(n) } : { id, name: pages.find((p) => p.pageId === id)!.name, type: 'PAGE' }
    }
    if (depth > 6) return '…'
    if (Array.isArray(v)) return v.slice(0, 500).map((x) => plain(x, depth + 1))
    const out: Rec = {}
    for (const [k, x] of Object.entries(v as Rec)) out[k] = plain(x, depth + 1)
    return out
  }
  const con = {
    log: (...a: unknown[]) => void logs.push(a.map(fmt).join(' ')),
    info: (...a: unknown[]) => void logs.push(a.map(fmt).join(' ')),
    warn: (...a: unknown[]) => void logs.push('warn: ' + a.map(fmt).join(' ')),
    error: (...a: unknown[]) => void logs.push('error: ' + a.map(fmt).join(' ')),
  }

  // The caller-supplied code runs in this same realm; isolation, time and memory limits come from the sandbox around it.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...params: string[]) => (...args: unknown[]) => Promise<unknown>
  const result = await new AsyncFunction('figma', 'console', code)(figma, con)

  recordOverrides()
  for (const p of pages) compact(p)
  return { result: plain(result, 0), logs, warnings: [...warnings], selection, currentPageId: current.pageId }
}

export const USE_FIGMA_GUIDE = `# use_figma — Plugin API subset supported by this file format

Your code runs as the body of an async function with a \`figma\` global; \`return\` a value to get it back (nodes come back as {id, name, type}).
Changes are applied to the file when the script finishes without throwing; if it throws, nothing is saved.

Supported:
- Document: figma.root.children (pages), figma.currentPage, await figma.setCurrentPageAsync(page), figma.createPage(), figma.getNodeById / getNodeByIdAsync,
  page.children / findAll / findOne / findAllWithCriteria({types}), page.selection (get/set), figma.viewport.scrollAndZoomIntoView(nodes).
- Create: createFrame, createRectangle, createEllipse, createLine, createPolygon, createStar, createVector, createText, createComponent, createSection,
  createNodeFromSvg(svg), createComponentFromNode(node), node.clone(), component.createInstance(), figma.group / ungroup,
  figma.union / subtract / intersect / exclude, figma.combineAsVariants. New nodes start on figma.currentPage; use parent.appendChild(node) / insertChild(i, node).
- Geometry: x, y, node.resize(w, h) (width/height are read-only), rotation (degrees, counter-clockwise like Figma), constraints, absoluteBoundingBox.
- Appearance: fills / strokes as Figma paints ({type:'SOLID', color:{r,g,b}} with 0..1 channels, gradients with gradientStops, IMAGE with
  imageHash from await figma.createImageAsync(url)), strokeWeight, strokeAlign, dashPattern, cornerRadius, topLeftRadius…, effects (DROP_SHADOW / INNER_SHADOW
  with color {r,g,b,a}, offset, radius, spread; LAYER_BLUR), opacity, blendMode, visible, locked, isMask, clipsContent.
- Auto layout: layoutMode, itemSpacing, padding*, primaryAxisAlignItems, counterAxisAlignItems, layoutSizingHorizontal/Vertical ('FIXED'|'HUG'|'FILL'),
  primaryAxisSizingMode / counterAxisSizingMode, layoutGrow, layoutAlign, layoutWrap, layoutPositioning, min/max width/height.
- Text: characters, fontSize, fontName {family, style}, lineHeight, letterSpacing, textAlignHorizontal/Vertical, textAutoResize, textDecoration, textCase,
  setRangeFontSize / setRangeFontName / setRangeFills / setRangeTextDecoration / setRangeLetterSpacing. loadFontAsync is accepted (fonts load on demand).
- Vectors: vectorPaths = [{windingRule, data}] (SVG path data in the node's width × height box — call resize first).
- Prototyping: await node.setReactionsAsync(reactions) / node.reactions in Figma's shape (NODE actions NAVIGATE or OVERLAY, BACK, CLOSE, URL; transitions DISSOLVE, SMART_ANIMATE, MOVE_IN, PUSH, SLIDE_IN), page.flowStartingPoints, and on frames overflowDirection, scrollBehavior ('FIXED'), overlayPositionType, overlayBackground, overlayBackgroundInteraction (settable here, unlike in Figma).
- Components: instance.mainComponent, detachInstance(), swapComponent(component); edits to instance layers become overrides.
- Styles: figma.createPaintStyle() / createTextStyle() / createEffectStyle(), getLocalPaintStylesAsync() / getLocalTextStylesAsync() / getLocalEffectStylesAsync(), style.remove(), node.fillStyleId / textStyleId / setEffectStyleIdAsync (effect styles are copied onto the layer, not saved as shared styles).
- Plugin data: node / style getPluginData / setPluginData / getSharedPluginData / setSharedPluginData are saved with the file.

- Sections: figma.createSection() (type 'SECTION'); video fills: {type:'VIDEO', url, posterUrl?} in fills.
- Limits: the script has 90 seconds and 256 MB, and no network, timers that wait, or Node / browser globals; setTimeout callbacks run immediately.

Not supported (throws or is ignored with a warning): variables, effect/grid styles, exportAsync (use get_screenshot / download_assets),
plugin data, flatten, FigJam / Slides nodes, and any property not listed above.`
