import { buildIndex, kids, type DocIndex } from './doc'
import { boundsOf, corners, localMatrix, rotate, apply } from './geometry'
import { fontSizeOf, layoutText, lineHeightOf, type MeasureFn } from './text'
import { isAutoLayout, type SceneNode } from './types'

const GEOM = ['x', 'y', 'width', 'height'] as const

export interface LayoutResult {
  nodes: SceneNode[]
  index: DocIndex
  /** Geometry that differs from the input — persist these to keep stored values in sync. */
  patches: { id: string; patch: Partial<SceneNode> }[]
}

/**
 * Resolves derived geometry: auto-layout frames, hug sizing, auto-sized text and group bounds.
 * Pure: input nodes are not mutated.
 */
export function runLayout(input: SceneNode[], measure: MeasureFn): LayoutResult {
  const nodes = input.map((n) => ({ ...n }))
  const index = buildIndex(nodes)
  for (const id of kids(index, '')) layoutNode(index, id, measure)
  const patches: LayoutResult['patches'] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = input[i]
    const b = nodes[i]
    let patch: Partial<SceneNode> | null = null
    for (const k of GEOM) if (Math.abs(a[k] - b[k]) > 0.01) (patch ??= {})[k] = b[k]
    if (patch) patches.push({ id: a.id, patch })
  }
  return { nodes, index, patches }
}

function sizeText(n: SceneNode, measure: MeasureFn, forcedW?: number) {
  const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
  if (forcedW != null) {
    n.width = forcedW
    if (mode !== 'NONE') n.height = layoutText(n, measure, forcedW).height
  } else if (mode === 'WIDTH_AND_HEIGHT') {
    const t = layoutText(n, measure)
    n.width = Math.max(1, Math.ceil(t.width))
    n.height = t.height
  } else if (mode === 'HEIGHT') {
    n.height = layoutText(n, measure, n.width).height
  }
}

function fitGroup(n: SceneNode, children: SceneNode[]) {
  if (!children.length) return
  const b = boundsOf(children.flatMap((c) => corners(localMatrix(c), c.width, c.height)))
  if (Math.abs(b.x) > 1e-6 || Math.abs(b.y) > 1e-6) {
    for (const c of children) {
      c.x -= b.x
      c.y -= b.y
    }
    const d = apply(rotate(n.rotation ?? 0), { x: b.x, y: b.y })
    n.x += d.x
    n.y += d.y
  }
  n.width = b.w
  n.height = b.h
}

function clampSize(n: SceneNode) {
  if (n.minWidth != null && n.width < n.minWidth) n.width = n.minWidth
  if (n.maxWidth != null && n.width > n.maxWidth) n.width = Math.max(n.maxWidth, n.minWidth ?? 0)
  if (n.minHeight != null && n.height < n.minHeight) n.height = n.minHeight
  if (n.maxHeight != null && n.height > n.maxHeight) n.height = Math.max(n.maxHeight, n.minHeight ?? 0)
}

function layoutNode(ix: DocIndex, id: string, measure: MeasureFn, forcedW?: number, forcedH?: number) {
  const n = ix.byId.get(id)!
  if (forcedW != null) n.width = forcedW
  if (forcedH != null) n.height = forcedH
  if (forcedW != null || forcedH != null) {
    clampSize(n)
    if (forcedW != null) forcedW = n.width
    if (forcedH != null) forcedH = n.height
  }
  if (n.type === 'TEXT') return sizeText(n, measure, forcedW)

  const children = kids(ix, id).map((c) => ix.byId.get(c)!)
  if (!isAutoLayout(n)) {
    for (const c of children) layoutNode(ix, c.id, measure)
    if (n.type === 'GROUP') fitGroup(n, children)
    return
  }

  const horiz = n.layoutMode === 'HORIZONTAL'
  const P = horiz ? 'width' : 'height'
  const C = horiz ? 'height' : 'width'
  const PP = horiz ? 'x' : 'y'
  const CP = horiz ? 'y' : 'x'
  const sizingP = (m: SceneNode) => (horiz ? m.layoutSizingHorizontal : m.layoutSizingVertical) ?? 'FIXED'
  const sizingC = (m: SceneNode) => (horiz ? m.layoutSizingVertical : m.layoutSizingHorizontal) ?? 'FIXED'
  const forcedP = horiz ? forcedW : forcedH
  const forcedC = horiz ? forcedH : forcedW
  const hugP = sizingP(n) === 'HUG' && forcedP == null
  const hugC = sizingC(n) === 'HUG' && forcedC == null
  const padP0 = (horiz ? n.paddingLeft : n.paddingTop) ?? 0
  const padP1 = (horiz ? n.paddingRight : n.paddingBottom) ?? 0
  const padC0 = (horiz ? n.paddingTop : n.paddingLeft) ?? 0
  const padC1 = (horiz ? n.paddingBottom : n.paddingRight) ?? 0
  const gap = n.itemSpacing ?? 0

  const flow: SceneNode[] = []
  for (const c of children) {
    if (c.visible === false || c.layoutPositioning === 'ABSOLUTE') layoutNode(ix, c.id, measure)
    else flow.push(c)
  }

  if (horiz && n.layoutWrap && !hugP) return layoutWrapped(n, flow, ix, measure, hugC)

  const innerC = n[C] - padC0 - padC1
  const call = (c: SceneNode, p?: number, cc?: number) =>
    horiz ? layoutNode(ix, c.id, measure, p, cc) : layoutNode(ix, c.id, measure, cc, p)

  // Pass 1: children that do not fill the primary axis.
  const fillers: SceneNode[] = []
  for (const c of flow) {
    const fillP = sizingP(c) === 'FILL' && !hugP
    const fillC = sizingC(c) === 'FILL' && !hugC
    if (fillP) fillers.push(c)
    else call(c, undefined, fillC ? Math.max(0, innerC) : undefined)
  }

  // Pass 2: distribute remaining primary space among fillers.
  const gaps = gap * Math.max(0, flow.length - 1)
  if (fillers.length) {
    const fixed = flow.filter((c) => !fillers.includes(c)).reduce((s, c) => s + c[P], 0)
    const each = Math.max(0, (n[P] - padP0 - padP1 - fixed - gaps) / fillers.length)
    for (const c of fillers) call(c, each, sizingC(c) === 'FILL' && !hugC ? Math.max(0, innerC) : undefined)
  }

  const sumP = flow.reduce((s, c) => s + c[P], 0)
  if (hugP) n[P] = padP0 + sumP + gaps + padP1
  // Baseline alignment (horizontal rows only): each child is moved down so its first baseline meets the lowest one.
  const byBaseline = horiz && n.counterAxisAlignItems === 'BASELINE'
  const bases = byBaseline ? flow.map((c) => baselineOf(ix, c)) : []
  const top = byBaseline ? Math.max(0, ...bases) : 0
  if (hugC) n[C] = padC0 + flow.reduce((m, c, i) => Math.max(m, c[C] + (byBaseline ? top - bases[i] : 0)), 0) + padC1
  clampSize(n)

  // Position.
  const innerP = n[P] - padP0 - padP1
  const innerC2 = n[C] - padC0 - padC1
  let cursor = padP0
  let step = gap
  const align = n.primaryAxisAlignItems ?? 'MIN'
  if (align === 'CENTER') cursor += (innerP - sumP - gaps) / 2
  else if (align === 'MAX') cursor += innerP - sumP - gaps
  else if (align === 'SPACE_BETWEEN' && flow.length > 1) step = (innerP - sumP) / (flow.length - 1)
  const cAlign = n.counterAxisAlignItems ?? 'MIN'
  flow.forEach((c, i) => {
    c[PP] = cursor
    c[CP] = padC0 + (byBaseline ? top - bases[i] : cAlign === 'CENTER' ? (innerC2 - c[C]) / 2 : cAlign === 'MAX' ? innerC2 - c[C] : 0)
    cursor += c[P] + step
  })
}

/** Distance from a node's top to its first text baseline (as text is drawn); a node without text uses its bottom. */
export function baselineOf(ix: DocIndex, c: SceneNode, depth = 0): number {
  if (c.type === 'TEXT') {
    const fs = fontSizeOf(c)
    return (lineHeightOf(c) - fs * 1.21) / 2 + fs * 0.969
  }
  if (c.type === 'FRAME' && c.layoutMode && c.layoutMode !== 'NONE' && depth < 20) {
    const first = kids(ix, c.id)
      .map((id) => ix.byId.get(id)!)
      .find((k) => k.visible !== false && k.layoutPositioning !== 'ABSOLUTE')
    if (first) return first.y + baselineOf(ix, first, depth + 1)
  }
  return c.height
}

/** Horizontal auto layout that wraps children onto new rows. */
function layoutWrapped(n: SceneNode, flow: SceneNode[], ix: DocIndex, measure: MeasureFn, hugH: boolean) {
  const pl = n.paddingLeft ?? 0
  const pr = n.paddingRight ?? 0
  const pt = n.paddingTop ?? 0
  const pb = n.paddingBottom ?? 0
  const gap = n.itemSpacing ?? 0
  const rowGap = n.counterAxisSpacing ?? gap
  const inner = Math.max(0, n.width - pl - pr)
  for (const c of flow) layoutNode(ix, c.id, measure, c.layoutSizingHorizontal === 'FILL' ? inner : undefined)
  const rows: SceneNode[][] = []
  let row: SceneNode[] = []
  let used = 0
  for (const c of flow) {
    if (row.length && used + gap + c.width > inner + 0.01) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length ? gap : 0) + c.width
    row.push(c)
  }
  if (row.length) rows.push(row)
  const heights = rows.map((r) => r.reduce((m, c) => Math.max(m, c.height), 0))
  const total = heights.reduce((s, h) => s + h, 0) + rowGap * Math.max(0, rows.length - 1)
  if (hugH) n.height = pt + total + pb
  clampSize(n)
  const align = n.primaryAxisAlignItems ?? 'MIN'
  const cAlign = n.counterAxisAlignItems ?? 'MIN'
  let y = pt
  rows.forEach((r, i) => {
    const sum = r.reduce((s, c) => s + c.width, 0)
    const gaps = gap * (r.length - 1)
    let x = pl
    let step = gap
    if (align === 'CENTER') x += (inner - sum - gaps) / 2
    else if (align === 'MAX') x += inner - sum - gaps
    else if (align === 'SPACE_BETWEEN' && r.length > 1) step = (inner - sum) / (r.length - 1)
    for (const c of r) {
      c.x = x
      c.y = y + (cAlign === 'CENTER' ? (heights[i] - c.height) / 2 : cAlign === 'MAX' ? heights[i] - c.height : 0)
      x += c.width + step
    }
    y += heights[i] + rowGap
  })
}
