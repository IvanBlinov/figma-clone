import { cssColor, kids, parentOf, ROOT, worldMatrix, type DocIndex } from './doc'
import { boundsOf, corners, IDENTITY, localMatrix, unionBoxes, type Box, type Mat } from './geometry'
import { fillRuleOf, isBoolean, paintsSelf, shapeOf } from './boolean'
import { arrowHeads, gradientLine, nodeShape, strokeInset, visiblePaints } from './paths'
import { fontSizeOf, layoutText, textOrigin, wrapWidthOf, type MeasureFn } from './text'
import type { Paint, SceneNode } from './types'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (v: number) => (Math.round(v * 1000) / 1000).toString()
const mat = (m: Mat) => `matrix(${m.map(num).join(' ')})`

export interface SvgOptions {
  measure: MeasureFn
  background?: string
  scale?: number
  /** Optional replacement for image URLs (e.g. inlined data URIs). */
  images?: Map<string, string>
}

export function exportBounds(ix: DocIndex, ids: string[]): Box {
  return unionBoxes(
    ids.map((id) => {
      const n = ix.byId.get(id)!
      return boundsOf(corners(worldMatrix(ix, id), n.width, n.height))
    }),
  )
}

/** Render nodes (with their subtrees) to a standalone SVG document. */
export function exportSvg(ix: DocIndex, ids: string[], opts: SvgOptions): { svg: string; width: number; height: number } {
  const b = exportBounds(ix, ids)
  const scale = opts.scale ?? 1
  const defs: string[] = []
  let uid = 0
  const nextId = (p: string) => `${p}${++uid}`

  const paintAttr = (p: Paint, n: SceneNode): string | null => {
    if (p.type === 'SOLID') return cssColor(p.color, p.opacity ?? 1)
    if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
      const id = nextId('g')
      const stops = p.stops
        .map(
          (s) =>
            `<stop offset="${num(s.position)}" stop-color="${cssColor(s.color)}" stop-opacity="${num((s.opacity ?? 1) * (p.opacity ?? 1))}"/>`,
        )
        .join('')
      if (p.type === 'GRADIENT_LINEAR') {
        const l = gradientLine(p.angle ?? 90, n.width, n.height)
        defs.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(l.x1)}" y1="${num(l.y1)}" x2="${num(l.x2)}" y2="${num(l.y2)}">${stops}</linearGradient>`,
        )
      } else {
        defs.push(
          `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(n.width / 2)}" cy="${num(n.height / 2)}" r="${num(Math.max(n.width, n.height) / 2)}">${stops}</radialGradient>`,
        )
      }
      return `url(#${id})`
    }
    return null
  }

  const renderText = (n: SceneNode): string => {
    const t = layoutText(n, opts.measure, wrapWidthOf(n))
    const o = textOrigin(n, t)
    const fs = fontSizeOf(n)
    const hAlign = n.textAlignHorizontal ?? 'LEFT'
    const anchor = hAlign === 'CENTER' ? 'middle' : hAlign === 'RIGHT' ? 'end' : 'start'
    const ax = hAlign === 'CENTER' ? n.width / 2 : hAlign === 'RIGHT' ? n.width : 0
    const paint = visiblePaints(n.fills)[0]
    const fill = paint ? (paintAttr(paint, n) ?? '#000') : 'none'
    const decoAttr = (d?: string) => (d === 'UNDERLINE' ? ' text-decoration="underline"' : d === 'STRIKETHROUGH' ? ' text-decoration="line-through"' : '')
    let spans = ''
    for (const line of t.lines) {
      const y = num(o.top + line.y + line.baseline)
      // Single-style lines keep an anchor so alignment survives font differences in other renderers.
      if (line.segs.length <= 1 && !line.segs[0]?.run) {
        spans += `<tspan x="${num(ax)}" y="${y}" text-anchor="${anchor}">${esc(line.text) || ' '}</tspan>`
        continue
      }
      const x0 = o.lineX(line)
      for (const seg of line.segs) {
        const rs = seg.run?.style
        let at = `x="${num(x0 + seg.x)}" y="${y}" text-anchor="start"`
        if (rs) {
          if (rs.fontFamily) at += ` font-family="${esc(rs.fontFamily)}, Inter, Arial, sans-serif"`
          if (rs.fontSize != null) at += ` font-size="${num(rs.fontSize)}"`
          if (rs.fontWeight != null) at += ` font-weight="${rs.fontWeight}"`
          if (rs.italic != null) at += ` font-style="${rs.italic ? 'italic' : 'normal'}"`
          if (rs.letterSpacing != null) at += ` letter-spacing="${num(rs.letterSpacing)}"`
          if (rs.textDecoration) at += decoAttr(rs.textDecoration) || ' text-decoration="none"'
          if (rs.fills) {
            const rp = visiblePaints(rs.fills)[0]
            at += ` fill="${rp ? (paintAttr(rp, n) ?? '#000') : 'none'}"`
          }
        }
        spans += `<tspan ${at}>${esc(seg.text)}</tspan>`
      }
    }
    return (
      `<text xml:space="preserve" font-family="${esc(n.fontFamily ?? 'Inter')}, Inter, Arial, sans-serif" font-size="${num(fs)}" font-weight="${n.fontWeight ?? 400}"` +
      `${n.italic ? ' font-style="italic"' : ''}${n.letterSpacing ? ` letter-spacing="${num(n.letterSpacing)}"` : ''}${decoAttr(n.textDecoration)} fill="${fill}">${spans}</text>`
    )
  }

  /** Children of a container, with masks clipping the siblings above them. */
  const renderChildren = (id: string): string => {
    let out = ''
    let open = 0
    for (const c of kids(ix, id)) {
      const cn = ix.byId.get(c)!
      if (cn.isMask && cn.visible !== false) {
        const shape = shapeOf(ix, cn)
        if (shape) {
          const cid = nextId('m')
          defs.push(`<clipPath id="${cid}"><path d="${shape.d}" transform="${mat(localMatrix(cn))}${shape.sx !== 1 || shape.sy !== 1 ? ` scale(${num(shape.sx)} ${num(shape.sy)})` : ''}" clip-rule="${fillRuleOf(cn)}"/></clipPath>`)
          out += `<g clip-path="url(#${cid})">`
          open++
        }
        continue
      }
      out += renderNode(c)
    }
    return out + '</g>'.repeat(open)
  }

  const renderNode = (id: string): string => {
    const n = ix.byId.get(id)!
    if (n.visible === false) return ''
    const attrs: string[] = [`transform="${mat(localMatrix(n))}"`]
    if ((n.opacity ?? 1) < 1) attrs.push(`opacity="${num(n.opacity ?? 1)}"`)
    if (n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH')
      attrs.push(`style="mix-blend-mode:${n.blendMode.toLowerCase().replace(/_/g, '-')}"`)

    const fx = (n.effects ?? []).filter((e) => e.visible !== false)
    const prims: string[] = []
    for (const e of fx) {
      if (e.type === 'DROP_SHADOW')
        prims.push(
          `<feDropShadow dx="${num(e.x)}" dy="${num(e.y)}" stdDeviation="${num(e.blur / 2)}" flood-color="${cssColor(e.color)}" flood-opacity="${num(e.opacity ?? 1)}"/>`,
        )
      else if (e.type === 'LAYER_BLUR') prims.push(`<feGaussianBlur stdDeviation="${num(e.radius / 2)}"/>`)
    }
    if (prims.length) {
      const fid = nextId('f')
      defs.push(
        `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${prims.join('')}</filter>`,
      )
      attrs.push(`filter="url(#${fid})"`)
    }

    let body = ''
    if (n.type === 'TEXT') body = renderText(n)
    else {
      const shape = shapeOf(ix, n)!
      const scaleAttr = shape.sx !== 1 || shape.sy !== 1 ? ` transform="scale(${num(shape.sx)} ${num(shape.sy)})" vector-effect="non-scaling-stroke"` : ''
      const rule = fillRuleOf(n) === 'evenodd' ? ' fill-rule="evenodd" clip-rule="evenodd"' : ''
      let clipId = ''
      const needClip = () => {
        if (!clipId) {
          clipId = nextId('c')
          defs.push(`<clipPath id="${clipId}"><path d="${shape.d}"${scaleAttr}${rule}/></clipPath>`)
        }
        return clipId
      }
      if (n.type !== 'LINE' && paintsSelf(n))
        for (const p of visiblePaints(n.fills)) {
          if (p.type === 'IMAGE') {
            const par = p.scaleMode === 'FIT' ? 'xMidYMid meet' : p.scaleMode === 'STRETCH' ? 'none' : 'xMidYMid slice'
            body += `<image href="${esc(opts.images?.get(p.url) ?? p.url)}" width="${num(n.width)}" height="${num(n.height)}" preserveAspectRatio="${par}" clip-path="url(#${needClip()})"${(p.opacity ?? 1) < 1 ? ` opacity="${num(p.opacity ?? 1)}"` : ''}/>`
          } else {
            const fill = paintAttr(p, n)
            if (fill) body += `<path d="${shape.d}"${scaleAttr}${rule} fill="${fill}"/>`
          }
        }
      const children = isBoolean(n) ? '' : renderChildren(id)
      if (children) body += n.type === 'FRAME' && n.clipsContent !== false ? `<g clip-path="url(#${needClip()})">${children}</g>` : children
      const sw = n.strokeWeight ?? 1
      if (sw > 0 && paintsSelf(n)) {
        const sShape = isBoolean(n) ? shape : nodeShape(n, strokeInset(n, shape))!
        const heads = arrowHeads(n)
        for (const p of visiblePaints(n.strokes)) {
          const stroke = paintAttr(p, n)
          if (!stroke) continue
          const dash = n.dashPattern?.length ? ` stroke-dasharray="${n.dashPattern.map(num).join(' ')}"` : ''
          const cap = n.strokeCap === 'ROUND' ? ' stroke-linecap="round" stroke-linejoin="round"' : n.strokeCap === 'SQUARE' ? ' stroke-linecap="square"' : ''
          body += `<path d="${sShape.d}"${scaleAttr} fill="none" stroke="${stroke}" stroke-width="${num(sw)}"${dash}${cap}/>`
          if (heads) body += `<path d="${heads}" fill="none" stroke="${stroke}" stroke-width="${num(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`
        }
      }
    }
    return `<g ${attrs.join(' ')}>${body}</g>`
  }

  let content = ''
  for (const id of ids) {
    const p = parentOf(ix, id)
    const pm = p === ROOT ? IDENTITY : worldMatrix(ix, p)
    content += `<g transform="${mat(pm)}">${renderNode(id)}</g>`
  }
  const w = Math.max(1, Math.ceil(b.w))
  const h = Math.max(1, Math.ceil(b.h))
  const bg = opts.background ? `<rect width="${w}" height="${h}" fill="${opts.background}"/>` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w * scale)}" height="${num(h * scale)}" viewBox="0 0 ${w} ${h}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    bg +
    `<g transform="translate(${num(-b.x)} ${num(-b.y)})">${content}</g></svg>`
  return { svg, width: w * scale, height: h * scale }
}
