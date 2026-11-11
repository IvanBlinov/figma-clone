import { Component, Eye, EyeOff, LayoutGrid, Minus, Plus, Unlink } from 'lucide-react'
import { useState } from 'react'
import { cloneSubtrees, cssColor, descendants, kids, nextOrder, parentOf, ROOT } from '../../shared/doc'
import { isAutoLayout, VIDEO_FALLBACK, type Constraint, type LayoutGrid as Grid, type Paint, type SceneNode } from '../../shared/types'
import { createInstance, detachInstances, goToMainComponent, resetOverrides, swapInstance, update } from './actions'
import { commit, S, useEditor } from './store'
import { TEXT_STYLE_KEYS, textStyleOf, useStyles, type StyleDoc } from './stylesStore'
import { IconBtn, NumInput, Popover, Section, Select, TextInput, type ChangeMode } from './ui'

type Patch = Partial<SceneNode> | ((n: SceneNode) => Partial<SceneNode>)
type SetFn = (p: Patch, m: ChangeMode) => void

function same<T>(nodes: SceneNode[], get: (n: SceneNode) => T): T | undefined {
  const first = get(nodes[0])
  const key = JSON.stringify(first)
  return nodes.every((n) => JSON.stringify(get(n)) === key) ? first : undefined
}

// ---------- components ----------
function addVariant(setId: string) {
  const { doc } = S()
  const variants = kids(doc, setId).filter((id) => doc.byId.get(id)?.isComponent)
  const last = variants[variants.length - 1]
  if (!last) return
  const { nodes, idMap } = cloneSubtrees(doc, [last])
  const root = nodes.find((n) => n.id === idMap.get(last))!
  root.order = nextOrder(doc, setId)
  root.name = root.name.includes('=') ? root.name.replace(/=[^,]*$/, `=Variant ${variants.length + 1}`) : `Variant=${variants.length + 1}`
  commit(
    nodes.map((n) => ({ op: 'create' as const, node: n })),
    { select: [root.id] },
  )
}

export function ComponentSection({ nodes }: { nodes: SceneNode[] }) {
  const doc = useEditor((s) => s.doc)
  if (nodes.length !== 1) return null
  const n = nodes[0]
  const all = [...doc.byId.values()]
  if (n.isComponentSet)
    return (
      <Section
        title="Component set"
        actions={
          <IconBtn title="Add variant" onClick={() => addVariant(n.id)}>
            <Plus size={14} />
          </IconBtn>
        }
      >
        <div className="hint">{kids(doc, n.id).filter((id) => doc.byId.get(id)?.isComponent).length} variants. Instances can switch between them.</div>
      </Section>
    )
  if (n.isComponent) {
    const count = all.filter((x) => x.componentId === n.id && !x.sourceId).length
    return (
      <Section title="Component">
        <div className="row">
          <button className="btn wide" onClick={() => createInstance(n.id)}>
            Insert instance
          </button>
        </div>
        <div className="hint">
          {count} instance{count === 1 ? '' : 's'} on this page. Changes to this component update them.
        </div>
      </Section>
    )
  }
  // Instance root, or a layer inside one.
  let root: SceneNode | undefined = n
  let guard = 0
  while (root && root.sourceId && root.parentId && guard++ < 200) root = doc.byId.get(root.parentId)
  if (!root?.componentId || (root.sourceId && root !== n)) {
    if (!n.componentId) return null
    root = n
  }
  const main = doc.byId.get(root.componentId!)
  const set = main?.parentId ? doc.byId.get(main.parentId) : undefined
  const variants = set?.isComponentSet ? kids(doc, set.id).map((id) => doc.byId.get(id)!).filter((c) => c.isComponent) : []
  const components = all.filter((c) => c.isComponent)
  const label = (c: SceneNode) => {
    const p = c.parentId ? doc.byId.get(c.parentId) : undefined
    return p?.isComponentSet ? `${p.name} / ${c.name}` : c.name
  }
  const nested = !!root.sourceId
  const hasOverrides = [root.id, ...descendants(doc, root.id)].some((id) => doc.byId.get(id)?.overrides?.length)
  const rootId = root.id
  return (
    <Section title={root === n ? 'Instance' : 'Inside instance'}>
      <div className="row instance-name">
        <Component size={12} />
        <span className="grow ellipsis">{main ? label(main) : 'Missing component'}</span>
      </div>
      {!nested && variants.length > 1 && (
        <div className="row">
          <Select className="grow" title="Variant" value={main!.id} onChange={(v) => swapInstance(rootId, v)} options={variants.map((v) => ({ value: v.id, label: v.name }))} />
        </div>
      )}
      {!nested && components.length > 1 && (
        <div className="row">
          <Select
            className="grow"
            title="Swap instance"
            value={main?.id}
            onChange={(v) => swapInstance(rootId, v)}
            options={components.filter((c) => c.id !== rootId && !descendants(doc, c.id).includes(rootId)).map((c) => ({ value: c.id, label: 'Swap: ' + label(c) }))}
          />
        </div>
      )}
      <div className="row">
        <button className="btn grow" disabled={!main} onClick={goToMainComponent}>
          Main
        </button>
        {!nested && (
          <>
            <button
              className="btn grow"
              disabled={!hasOverrides}
              onClick={() => {
                useEditor.setState({ selection: [rootId] })
                resetOverrides()
              }}
            >
              Reset
            </button>
            <button
              className="btn grow"
              title="Detach instance (Ctrl+Alt+B)"
              onClick={() => {
                useEditor.setState({ selection: [rootId] })
                detachInstances()
              }}
            >
              Detach
            </button>
          </>
        )}
      </div>
    </Section>
  )
}

// ---------- constraints ----------
const H_OPTS: { value: Constraint; label: string }[] = [
  { value: 'MIN', label: 'Left' },
  { value: 'MAX', label: 'Right' },
  { value: 'STRETCH', label: 'Left and right' },
  { value: 'CENTER', label: 'Center' },
  { value: 'SCALE', label: 'Scale' },
]
const V_OPTS: { value: Constraint; label: string }[] = [
  { value: 'MIN', label: 'Top' },
  { value: 'MAX', label: 'Bottom' },
  { value: 'STRETCH', label: 'Top and bottom' },
  { value: 'CENTER', label: 'Center' },
  { value: 'SCALE', label: 'Scale' },
]

export function ConstraintsSection({ nodes, set }: { nodes: SceneNode[]; set: SetFn }) {
  const doc = useEditor((s) => s.doc)
  const ok = nodes.every((n) => {
    const p = doc.byId.get(parentOf(doc, n.id))
    return !!p && p.type === 'FRAME' && (!isAutoLayout(p) || n.layoutPositioning === 'ABSOLUTE')
  })
  if (!ok) return null
  const h = same(nodes, (n) => n.constraints?.horizontal ?? 'MIN')
  const v = same(nodes, (n) => n.constraints?.vertical ?? 'MIN')
  return (
    <Section title="Constraints">
      <div className="row">
        <div className="constraint-box">
          <span className={'c-h ' + (h ?? '')} />
          <span className={'c-v ' + (v ?? '')} />
        </div>
        <div className="col grow">
          <Select title="Horizontal constraint" value={h} options={H_OPTS} onChange={(val) => set((n) => ({ constraints: { ...n.constraints, horizontal: val } }), 'commit')} />
          <Select title="Vertical constraint" value={v} options={V_OPTS} onChange={(val) => set((n) => ({ constraints: { ...n.constraints, vertical: val } }), 'commit')} />
        </div>
      </div>
    </Section>
  )
}

// ---------- layout grids ----------
export function GridSection({ nodes, set }: { nodes: SceneNode[]; set: SetFn }) {
  if (!nodes.every((n) => n.type === 'FRAME')) return null
  const grids = same(nodes, (n) => n.layoutGrids ?? [])
  const put = (list: Grid[], m: ChangeMode = 'commit') => set({ layoutGrids: list.length ? list : undefined }, m)
  return (
    <Section
      title="Layout grid"
      actions={
        <IconBtn title="Add layout grid (Shift+G toggles visibility)" onClick={() => put([...(grids ?? []), { pattern: 'GRID', size: 10, color: '#FF0000', opacity: 0.1 }])}>
          <Plus size={14} />
        </IconBtn>
      }
    >
      {(grids ?? []).map((g, i, arr) => {
        const at = (ng: Grid, m: ChangeMode) => put(arr.map((o, j) => (j === i ? ng : o)), m)
        return (
          <div key={i} className={'effect' + (g.visible === false ? ' muted' : '')}>
            <div className="row">
              <Select
                className="grow"
                value={g.pattern}
                onChange={(pattern) => at(pattern === 'GRID' ? { ...g, pattern, size: g.size ?? 10 } : { ...g, pattern, count: g.count ?? (pattern === 'COLUMNS' ? 12 : 6), gutter: g.gutter ?? 20, margin: g.margin ?? 0 }, 'commit')}
                options={[
                  { value: 'GRID', label: 'Grid' },
                  { value: 'COLUMNS', label: 'Columns' },
                  { value: 'ROWS', label: 'Rows' },
                ]}
              />
              {g.pattern === 'GRID' ? (
                <NumInput className="w56" title="Cell size" value={g.size ?? 10} min={1} onChange={(v, m) => at({ ...g, size: v }, m)} />
              ) : (
                <NumInput className="w56" title="Count" value={g.count ?? 5} min={1} max={100} onChange={(v, m) => at({ ...g, count: Math.round(v) }, m)} />
              )}
              <IconBtn title="Toggle visibility" onClick={() => at({ ...g, visible: g.visible === false }, 'commit')}>
                {g.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconBtn>
              <IconBtn title="Remove" onClick={() => put(arr.filter((_, j) => j !== i))}>
                <Minus size={14} />
              </IconBtn>
            </div>
            {g.pattern !== 'GRID' && (
              <div className="row">
                <NumInput label="Gutter" value={g.gutter ?? 20} min={0} onChange={(v, m) => at({ ...g, gutter: v }, m)} />
                <NumInput label="Margin" value={g.margin ?? 0} min={0} onChange={(v, m) => at({ ...g, margin: v }, m)} />
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

// ---------- shared styles ----------
const paintsCss = (paints: Paint[] | undefined) => {
  const p = paints?.[paints.length - 1]
  if (!p) return 'transparent'
  if (p.type === 'SOLID') return cssColor(p.color, p.opacity ?? 1)
  if (p.type === 'IMAGE') return `center / cover url("${p.url}")`
  if (p.type === 'VIDEO') return p.posterUrl ? `center / cover url("${p.posterUrl}")` : VIDEO_FALLBACK
  return `linear-gradient(${(p.angle ?? 90) + 90}deg, ${p.stops.map((s) => `${cssColor(s.color, s.opacity ?? 1)} ${s.position * 100}%`).join(', ')})`
}

function StyleSwatch({ s }: { s: StyleDoc }) {
  if (s.kind === 'PAINT')
    return (
      <span className="swatch checker round">
        <span style={{ background: paintsCss(s.value.paints) }} />
      </span>
    )
  return <span className="style-ag">Ag</span>
}

/** Button + popover to apply, create or detach a shared style for the selection. */
export function StyleButton({ nodes, kind }: { nodes: SceneNode[]; kind: 'PAINT' | 'TEXT' }) {
  const { styles, create } = useStyles()
  const [y, setY] = useState<number | null>(null)
  const list = styles.filter((s) => s.kind === kind)
  const ids = nodes.map((n) => n.id)
  const apply = (s: StyleDoc) => {
    if (kind === 'PAINT') update(ids, { fills: s.value.paints ?? [], fillStyleId: s._id })
    else update(ids, { ...(s.value.text ?? {}), textStyleId: s._id })
    setY(null)
  }
  const make = async () => {
    const name = prompt(kind === 'PAINT' ? 'Name of the new color style' : 'Name of the new text style', kind === 'PAINT' ? 'Primary' : 'Heading')
    if (!name?.trim()) return
    const n = nodes[0]
    const id = await create(kind, name.trim(), kind === 'PAINT' ? { paints: n.fills ?? [] } : { text: textStyleOf(n) })
    if (id) update(ids, kind === 'PAINT' ? { fillStyleId: id } : { textStyleId: id })
    setY(null)
  }
  return (
    <>
      <IconBtn title={kind === 'PAINT' ? 'Color styles' : 'Text styles'} onClick={(e) => setY(e.clientY)}>
        <LayoutGrid size={13} />
      </IconBtn>
      {y !== null && (
        <Popover anchorY={y} onClose={() => setY(null)} title={kind === 'PAINT' ? 'Color styles' : 'Text styles'}>
          <div className="style-list">
            {list.length === 0 && <div className="hint">No styles yet. Create one from the current selection.</div>}
            {list.map((s) => (
              <button key={s._id} className="style-row" onClick={() => apply(s)}>
                <StyleSwatch s={s} />
                <span className="grow ellipsis">{s.name}</span>
                {kind === 'TEXT' && <span className="dim">{s.value.text?.fontSize ?? 12}</span>}
              </button>
            ))}
            <button className="link-btn" onClick={() => void make()}>
              + Create style from selection
            </button>
          </div>
        </Popover>
      )}
    </>
  )
}

/** Shown instead of raw values when the selection uses a shared style. */
export function StyleChip({ nodes, kind }: { nodes: SceneNode[]; kind: 'PAINT' | 'TEXT' }) {
  const styles = useStyles((s) => s.styles)
  const id = same(nodes, (n) => (kind === 'PAINT' ? n.fillStyleId : n.textStyleId) ?? null)
  const s = id ? styles.find((x) => x._id === id) : undefined
  if (!s) return null
  return (
    <div className="row style-chip">
      <StyleSwatch s={s} />
      <span className="grow ellipsis">{s.name}</span>
      <IconBtn
        title="Detach style"
        onClick={() =>
          update(
            nodes.map((n) => n.id),
            kind === 'PAINT' ? { fillStyleId: undefined } : { textStyleId: undefined },
          )
        }
      >
        <Unlink size={13} />
      </IconBtn>
    </div>
  )
}

export function LocalStyles() {
  const { styles, update: updateStyle, remove } = useStyles()
  if (!styles.length) return null
  const group = (kind: StyleDoc['kind'], title: string) => {
    const list = styles.filter((s) => s.kind === kind)
    if (!list.length) return null
    return (
      <Section title={title}>
        {list.map((s) => {
          const first = s.value.paints?.[0]
          return (
            <div className="row style-chip" key={s._id}>
              {kind === 'PAINT' && first?.type === 'SOLID' ? (
                <label className="swatch checker round" title="Change color (updates every layer using this style)">
                  <span style={{ background: paintsCss(s.value.paints) }} />
                  <input
                    type="color"
                    hidden
                    value={first.color}
                    onChange={(e) => updateStyle(s._id, { value: { paints: [{ ...first, color: e.target.value.toUpperCase() }, ...(s.value.paints ?? []).slice(1)] } })}
                  />
                </label>
              ) : (
                <StyleSwatch s={s} />
              )}
              <TextInput className="grow" value={s.name} onCommit={(name) => name.trim() && updateStyle(s._id, { name: name.trim() })} />
              {kind === 'TEXT' && (
                <NumInput
                  className="w48 bare"
                  title="Font size (updates every layer using this style)"
                  value={s.value.text?.fontSize ?? 12}
                  min={1}
                  onChange={(v, m) => m === 'commit' && updateStyle(s._id, { value: { text: { ...s.value.text, fontSize: v } } })}
                />
              )}
              <IconBtn title="Delete style" onClick={() => remove(s._id)}>
                <Minus size={14} />
              </IconBtn>
            </div>
          )
        })}
      </Section>
    )
  }
  return (
    <>
      {group('PAINT', 'Color styles')}
      {group('TEXT', 'Text styles')}
    </>
  )
}

export const hasTextStyleKey = (patch: object) => TEXT_STYLE_KEYS.some((k) => k in patch)
export { ROOT }
