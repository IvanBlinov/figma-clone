// CSS for a node, for the Inspect panel, "Copy as CSS" and the MCP get_css tool.
import { cssColor, parentOf, ROOT, type DocIndex } from './doc'
import { visiblePaints } from './paths'
import { isAutoLayout, type Paint, type SceneNode } from './types'

const px = (v: number) => `${Math.round(v * 100) / 100}px`

function paintCss(p: Paint): string | null {
  if (p.type === 'SOLID') return cssColor(p.color, p.opacity ?? 1)
  if (p.type === 'IMAGE') return `url("${p.url}") center / ${p.scaleMode === 'FIT' ? 'contain' : p.scaleMode === 'STRETCH' ? '100% 100%' : 'cover'} no-repeat`
  const stops = p.stops.map((s) => `${cssColor(s.color, (s.opacity ?? 1) * (p.opacity ?? 1))} ${Math.round(s.position * 100)}%`).join(', ')
  return p.type === 'GRADIENT_LINEAR' ? `linear-gradient(${(p.angle ?? 90) + 90}deg, ${stops})` : `radial-gradient(${stops})`
}

/** CSS declarations for a node as [property, value] pairs. */
export function cssOf(ix: DocIndex, n: SceneNode): [string, string][] {
  const out: [string, string][] = []
  const pid = parentOf(ix, n.id)
  const parent = pid === ROOT ? undefined : ix.byId.get(pid)
  const inFlow = !!parent && isAutoLayout(parent) && n.layoutPositioning !== 'ABSOLUTE'
  if (parent && !inFlow) {
    out.push(['position', 'absolute'], ['left', px(n.x)], ['top', px(n.y)])
  }
  const horiz = parent?.layoutMode === 'HORIZONTAL'
  const fillW = inFlow && n.layoutSizingHorizontal === 'FILL'
  const fillH = inFlow && n.layoutSizingVertical === 'FILL'
  const hugW = (isAutoLayout(n) && n.layoutSizingHorizontal === 'HUG') || (n.type === 'TEXT' && (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT')
  const hugH = (isAutoLayout(n) && n.layoutSizingVertical === 'HUG') || (n.type === 'TEXT' && n.textAutoResize !== 'NONE')
  if (fillW) out.push(horiz ? ['flex', '1 0 0'] : ['align-self', 'stretch'])
  else if (!hugW) out.push(['width', px(n.width)])
  if (fillH) out.push(horiz ? ['align-self', 'stretch'] : ['flex', '1 0 0'])
  else if (!hugH && n.type !== 'LINE') out.push(['height', px(n.height)])
  if (n.minWidth != null) out.push(['min-width', px(n.minWidth)])
  if (n.maxWidth != null) out.push(['max-width', px(n.maxWidth)])
  if (n.minHeight != null) out.push(['min-height', px(n.minHeight)])
  if (n.maxHeight != null) out.push(['max-height', px(n.maxHeight)])
  if (n.rotation) out.push(['transform', `rotate(${n.rotation}deg)`], ['transform-origin', '0 0'])
  if ((n.opacity ?? 1) < 1) out.push(['opacity', String(Math.round((n.opacity ?? 1) * 100) / 100)])
  if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') out.push(['mix-blend-mode', n.blendMode.toLowerCase().replace(/_/g, '-')])

  if (isAutoLayout(n)) {
    out.push(['display', 'flex'], ['flex-direction', n.layoutMode === 'HORIZONTAL' ? 'row' : 'column'])
    if (n.layoutWrap) out.push(['flex-wrap', 'wrap'])
    const j = n.primaryAxisAlignItems ?? 'MIN'
    const a = n.counterAxisAlignItems ?? 'MIN'
    const map = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' } as const
    out.push(['justify-content', map[j]], ['align-items', map[a]])
    if (n.itemSpacing && j !== 'SPACE_BETWEEN') out.push(['gap', px(n.itemSpacing)])
    const pads = [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0]
    if (pads.some(Boolean))
      out.push(['padding', pads[0] === pads[2] && pads[1] === pads[3] ? (pads[0] === pads[1] ? px(pads[0]) : `${px(pads[0])} ${px(pads[1])}`) : pads.map(px).join(' ')])
  }

  const fills = visiblePaints(n.fills)
  if (n.type === 'TEXT') {
    const f = fills[0]
    if (f?.type === 'SOLID') out.push(['color', cssColor(f.color, f.opacity ?? 1)])
    out.push(['font-family', `"${n.fontFamily ?? 'Inter'}"`], ['font-size', px(n.fontSize ?? 12)], ['font-weight', String(n.fontWeight ?? 400)])
    if (n.italic) out.push(['font-style', 'italic'])
    out.push(['line-height', n.lineHeight != null ? px(n.lineHeight) : 'normal'])
    if (n.letterSpacing) out.push(['letter-spacing', px(n.letterSpacing)])
    if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') out.push(['text-align', n.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : n.textAlignHorizontal.toLowerCase()])
    if (n.textDecoration === 'UNDERLINE') out.push(['text-decoration', 'underline'])
    if (n.textDecoration === 'STRIKETHROUGH') out.push(['text-decoration', 'line-through'])
    if (n.textCase === 'UPPER') out.push(['text-transform', 'uppercase'])
    if (n.textCase === 'LOWER') out.push(['text-transform', 'lowercase'])
    if (n.textCase === 'TITLE') out.push(['text-transform', 'capitalize'])
  } else if (n.type !== 'GROUP' || n.booleanOp) {
    const bg = [...fills].reverse().map(paintCss).filter(Boolean)
    if (bg.length && n.type !== 'LINE') out.push(['background', bg.join(', ')])
    const stroke = visiblePaints(n.strokes)[0]
    const sw = n.strokeWeight ?? 1
    if (stroke && sw > 0) {
      const color = stroke.type === 'SOLID' ? cssColor(stroke.color, stroke.opacity ?? 1) : '#000'
      const style = n.dashPattern?.length ? 'dashed' : 'solid'
      if (n.type === 'LINE') out.push(['border-top', `${px(sw)} ${style} ${color}`])
      else if ((n.strokeAlign ?? 'INSIDE') === 'OUTSIDE') out.push(['outline', `${px(sw)} ${style} ${color}`])
      else out.push(['border', `${px(sw)} ${style} ${color}`])
    }
    if (n.type === 'ELLIPSE') out.push(['border-radius', '50%'])
    else if (n.cornerRadii) out.push(['border-radius', n.cornerRadii.map(px).join(' ')])
    else if (n.cornerRadius) out.push(['border-radius', px(n.cornerRadius)])
    if (n.type === 'FRAME' && n.clipsContent !== false) out.push(['overflow', 'hidden'])
  }

  const shadows: string[] = []
  for (const e of n.effects ?? []) {
    if (e.visible === false) continue
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
      shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread ?? 0)} ${cssColor(e.color, e.opacity ?? 1)}`)
    else out.push([e.type === 'LAYER_BLUR' ? 'filter' : 'backdrop-filter', `blur(${px((e as { radius: number }).radius / 2)})`])
  }
  if (shadows.length) out.push([n.type === 'TEXT' ? 'text-shadow' : 'box-shadow', n.type === 'TEXT' ? shadows.map((s) => s.replace(/ \S+px (rgba?\()/, ' $1')).join(', ') : shadows.join(', ')])
  return out
}

export function cssText(ix: DocIndex, n: SceneNode): string {
  return cssOf(ix, n)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n')
}
