import { kids, ROOT, sortByDocOrder, topLevelOnly } from '../../shared/doc'
import { exportBounds, exportSvg } from '../../shared/svg'
import { measureText } from './fonts'
import { renderToCanvas } from './render'
import { S } from './store'

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export function exportNodes(ids: string[], format: 'PNG' | 'JPG' | 'SVG', scale: number, fallbackName = 'export') {
  const { doc } = S()
  const list = sortByDocOrder(doc, topLevelOnly(doc, ids))
  if (!list.length) return
  const name = (list.length === 1 ? doc.byId.get(list[0])!.name : fallbackName).replace(/[\\/:*?"<>|]/g, '_')
  if (format === 'SVG') {
    const { svg } = exportSvg(doc, list, { measure: measureText })
    return download(new Blob([svg], { type: 'image/svg+xml' }), name + '.svg')
  }
  const canvas = renderToCanvas(doc, list, exportBounds(doc, list), scale, format === 'JPG' ? '#FFFFFF' : undefined)
  canvas.toBlob(
    (b) => b && download(b, `${name}${scale !== 1 ? `@${scale}x` : ''}.${format.toLowerCase()}`),
    format === 'JPG' ? 'image/jpeg' : 'image/png',
    0.92,
  )
}

/** Small JPEG preview of the page for the file browser. Returns null if the canvas is tainted or empty. */
export function makeThumbnail(): string | null {
  const st = S()
  const ids = kids(st.doc, ROOT)
  if (!ids.length) return null
  try {
    const b = exportBounds(st.doc, ids)
    const pad = Math.max(b.w, b.h) * 0.06
    const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
    const scale = Math.min(480 / box.w, 300 / box.h, 2)
    return renderToCanvas(st.doc, ids, box, scale, st.pageBg).toDataURL('image/jpeg', 0.72)
  } catch {
    return null
  }
}
