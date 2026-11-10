import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Component,
  Diamond,
  Search,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Eye,
  EyeOff,
  Frame,
  GalleryHorizontal,
  GalleryVertical,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  Plus,
  Spline,
  Square,
  SquareDashed,
  Star,
  Triangle,
  Type,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ancestors, kids, parentOf, ROOT } from '../../shared/doc'
import { exportBounds } from '../../shared/svg'
import { isAutoLayout, isContainer, type SceneNode } from '../../shared/types'
import { createInstance, moveNodes, update } from './actions'
import { renderToCanvas } from './render'
import { patchState, S, select, useEditor } from './store'

export function NodeIcon({ n }: { n: SceneNode }) {
  const p = { size: 12, strokeWidth: 1.75 }
  if (n.isMask) return <CircleDot {...p} />
  if (n.isComponent || n.isComponentSet) return <Component {...p} />
  if (n.componentId) return <Diamond {...p} />
  if (n.booleanOp === 'UNION') return <SquaresUnite {...p} />
  if (n.booleanOp === 'SUBTRACT') return <SquaresSubtract {...p} />
  if (n.booleanOp === 'INTERSECT') return <SquaresIntersect {...p} />
  if (n.booleanOp === 'EXCLUDE') return <SquaresExclude {...p} />
  if (isAutoLayout(n)) return n.layoutMode === 'HORIZONTAL' ? <GalleryHorizontal {...p} /> : <GalleryVertical {...p} />
  if ((n.fills ?? []).some((f) => f.type === 'IMAGE') && n.type === 'RECTANGLE') return <ImageIcon {...p} />
  switch (n.type) {
    case 'FRAME':
      return <Frame {...p} />
    case 'GROUP':
      return <SquareDashed {...p} />
    case 'ELLIPSE':
      return <Circle {...p} />
    case 'LINE':
      return <Minus {...p} />
    case 'POLYGON':
      return <Triangle {...p} />
    case 'STAR':
      return <Star {...p} />
    case 'VECTOR':
      return <Spline {...p} />
    case 'TEXT':
      return <Type {...p} />
    default:
      return <Square {...p} />
  }
}

interface PageInfo {
  _id: string
  name: string
}

interface Props {
  pages: PageInfo[]
  pageId: string | null
  onSelectPage: (id: string) => void
  onAddPage: () => void
  onRenamePage: (id: string, name: string) => void
  onDeletePage: (id: string) => void
}

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  return (
    <input
      className="inline-edit"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') onDone(null)
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

export function LayersPanel({ pages, pageId, onSelectPage, onAddPage, onRenamePage, onDeletePage }: Props) {
  const doc = useEditor((s) => s.doc)
  const selection = useEditor((s) => s.selection)
  const hover = useEditor((s) => s.hover)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingPage, setRenamingPage] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; zone: 'above' | 'below' | 'inside' } | null>(null)
  const [tab, setTab] = useState<'layers' | 'assets'>('layers')
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const lastClicked = useRef<string | null>(null)

  // Reveal the selection: expand its ancestors and scroll it into view.
  useEffect(() => {
    if (!selection.length) return
    const need = selection.flatMap((id) => (doc.byId.has(id) ? ancestors(doc, id) : []))
    if (need.some((a) => !expanded.has(a))) setExpanded((prev) => new Set([...prev, ...need]))
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${selection[0]}"]`)?.scrollIntoView({ block: 'nearest' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  const rows: { id: string; depth: number }[] = []
  const walk = (parent: string, depth: number) => {
    const list = kids(doc, parent)
    for (let i = list.length - 1; i >= 0; i--) {
      rows.push({ id: list[i], depth })
      if (expanded.has(list[i])) walk(list[i], depth + 1)
    }
  }
  const q = query.trim().toLowerCase()
  if (q) {
    for (const n of doc.byId.values()) if (n.name.toLowerCase().includes(q) || (n.type === 'TEXT' && (n.characters ?? '').toLowerCase().includes(q))) rows.push({ id: n.id, depth: 0 })
  } else walk(ROOT, 0)

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const click = (e: React.MouseEvent, id: string) => {
    const sel = S().selection
    if (e.shiftKey && lastClicked.current) {
      const a = rows.findIndex((r) => r.id === lastClicked.current)
      const b = rows.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) return select(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id))
    }
    lastClicked.current = id
    if (e.ctrlKey || e.metaKey) select(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id])
    else select([id])
  }

  const onDrop = () => {
    const d = drop
    setDrop(null)
    if (!d) return
    const st = S()
    const moving = st.selection.filter((id) => id !== d.id)
    if (!moving.length) return
    if (d.zone === 'inside') {
      setExpanded((prev) => new Set(prev).add(d.id))
      return moveNodes(moving, d.id)
    }
    const parent = parentOf(st.doc, d.id)
    const rest = kids(st.doc, parent).filter((k) => !moving.includes(k))
    moveNodes(moving, parent, rest.indexOf(d.id) + (d.zone === 'above' ? 1 : 0))
  }

  return (
    <>
      <div className="section pages">
        <div className="section-head">
          <span>Pages</span>
          <div className="section-actions">
            <button className="icon-btn" title="Add page" onClick={onAddPage}>
              <Plus size={14} />
            </button>
          </div>
        </div>
        {pages.map((p) => (
          <div
            key={p._id}
            className={'page-row' + (p._id === pageId ? ' active' : '')}
            onClick={() => onSelectPage(p._id)}
            onDoubleClick={() => setRenamingPage(p._id)}
          >
            {renamingPage === p._id ? (
              <InlineEdit
                value={p.name}
                onDone={(v) => {
                  setRenamingPage(null)
                  if (v && v !== p.name) onRenamePage(p._id, v)
                }}
              />
            ) : (
              <span className="grow ellipsis">{p.name}</span>
            )}
            {pages.length > 1 && (
              <button
                className="icon-btn hover-only"
                title="Delete page"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete page "${p.name}" and everything on it?`)) onDeletePage(p._id)
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="section-head layers-head">
        <span className={'head-tab' + (tab === 'layers' ? ' active' : '')} onClick={() => setTab('layers')}>
          Layers
        </span>
        <span className={'head-tab' + (tab === 'assets' ? ' active' : '')} onClick={() => setTab('assets')}>
          Assets
        </span>
      </div>
      {tab === 'assets' && <Assets />}
      {tab === 'layers' && (
        <label className="layer-search">
          <Search size={12} />
          <input
            id="layer-search"
            placeholder="Find layers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
              if (e.key === 'Enter' && rows.length) select(rows.map((r) => r.id))
            }}
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')}>
              <X size={11} />
            </button>
          )}
        </label>
      )}
      <div className="layers" ref={listRef} style={tab === 'layers' ? undefined : { display: 'none' }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onMouseLeave={() => S().hover && patchState({ hover: null })}>
        {rows.length === 0 && <div className="hint pad">{q ? 'No layers match.' : 'No layers yet. Pick a tool from the toolbar and draw on the canvas.'}</div>}
        {rows.map(({ id, depth }) => {
          const n = doc.byId.get(id)!
          const hasKids = isContainer(n) && kids(doc, id).length > 0
          const selected = selection.includes(id)
          const parentSelected = !selected && ancestors(doc, id).some((a) => selection.includes(a))
          const cls =
            'layer-row' +
            (selected ? ' selected' : '') +
            (parentSelected ? ' child-selected' : '') +
            (hover === id ? ' hovered' : '') +
            (n.visible === false ? ' hidden-node' : '') +
            (drop?.id === id ? ' drop-' + drop.zone : '') +
            (n.type === 'FRAME' && !n.parentId ? ' top-frame' : '') +
            (n.isComponent || n.isComponentSet || n.componentId || n.sourceId ? ' purple' : '') +
            (n.isMask ? ' mask' : '')
          return (
            <div
              key={id}
              data-id={id}
              className={cls}
              style={{ paddingLeft: 8 + depth * 16 }}
              draggable={renaming !== id && !q}
              onDragStart={(e) => {
                if (!S().selection.includes(id)) select([id])
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const f = (e.clientY - r.top) / r.height
                const zone = isContainer(n) && f > 0.25 && f < 0.75 ? 'inside' : f < 0.5 ? 'above' : 'below'
                if (drop?.id !== id || drop.zone !== zone) setDrop({ id, zone })
              }}
              onDragEnd={() => setDrop(null)}
              onClick={(e) => click(e, id)}
              onDoubleClick={() => setRenaming(id)}
              onMouseEnter={() => patchState({ hover: id })}
            >
              <span
                className="chevron"
                onClick={(e) => {
                  e.stopPropagation()
                  if (hasKids) toggle(id)
                }}
              >
                {hasKids ? expanded.has(id) ? <ChevronDown size={10} /> : <ChevronRight size={10} /> : null}
              </span>
              <span className="layer-icon">
                <NodeIcon n={n} />
              </span>
              {renaming === id ? (
                <InlineEdit
                  value={n.name}
                  onDone={(v) => {
                    setRenaming(null)
                    if (v && v !== n.name) update([id], { name: v })
                  }}
                />
              ) : (
                <span className="grow ellipsis">{n.name}</span>
              )}
              <button
                className={'icon-btn' + (n.locked ? '' : ' hover-only')}
                title={n.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => {
                  e.stopPropagation()
                  update([id], { locked: n.locked ? undefined : true })
                }}
              >
                {n.locked ? <Lock size={12} /> : <LockOpen size={12} />}
              </button>
              <button
                className={'icon-btn' + (n.visible === false ? '' : ' hover-only')}
                title={n.visible === false ? 'Show' : 'Hide'}
                onClick={(e) => {
                  e.stopPropagation()
                  update([id], { visible: n.visible === false ? undefined : false })
                }}
              >
                {n.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}

/** Components on this page: click to insert an instance, or drag one onto the canvas. */
function Assets() {
  const doc = useEditor((s) => s.doc)
  const comps = useMemo(() => [...doc.byId.values()].filter((n) => n.isComponent), [doc])
  const thumbs = useMemo(() => {
    const out = new Map<string, string>()
    for (const c of comps.slice(0, 60)) {
      try {
        const b = exportBounds(doc, [c.id])
        const scale = Math.min(2, 96 / Math.max(b.w, b.h, 1))
        out.set(c.id, renderToCanvas(doc, [c.id], b, scale).toDataURL())
      } catch {
        /* tainted canvas (cross-origin image): no preview */
      }
    }
    return out
  }, [comps, doc])
  if (!comps.length)
    return (
      <div className="hint pad">
        No components on this page yet. Select a frame and press <b>Ctrl+Alt+K</b> to create one.
      </div>
    )
  return (
    <div className="assets">
      {comps.map((c) => {
        const parent = c.parentId ? doc.byId.get(c.parentId) : undefined
        return (
          <button
            key={c.id}
            className="asset"
            title="Click to insert, or drag onto the canvas"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('application/x-figclone-component', c.id)
            }}
            onClick={() => createInstance(c.id)}
          >
            <span className="asset-thumb">{thumbs.get(c.id) ? <img src={thumbs.get(c.id)} alt="" draggable={false} /> : <Component size={20} />}</span>
            <span className="ellipsis">{parent?.isComponentSet ? `${parent.name} / ${c.name}` : c.name}</span>
          </button>
        )
      })}
    </div>
  )
}
