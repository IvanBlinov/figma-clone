import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalSpaceAround,
  ArrowDown,
  ArrowRight,
  Eye,
  EyeOff,
  Link2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  Scan,
  SquareRoundCorner,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
} from 'lucide-react'
import { useState } from 'react'
import { cssColor, parentOf } from '../../shared/doc'
import { stylesInRange } from '../../shared/text'
import { isAutoLayout, nodeLabel, type BooleanOp, type Effect, type Paint, type SceneNode, type Sizing } from '../../shared/types'
import { addAutoLayout, alignSelection, booleanOperation, commitDraft, distributeSelection, placeImageUrl, preview, removeAutoLayout, sizeSideEffects, styleText, update } from './actions'
import { exportNodes } from './export'
import { FONTS } from './fonts'
import { ComponentSection, ConstraintsSection, GridSection, hasTextStyleKey, LocalStyles, StyleButton, StyleChip } from './PanelExtras'
import { S, useEditor } from './store'
import { focusProxy } from './textEdit'
import { ColorPicker, IconBtn, normalizeHex, NumInput, Popover, Section, Select, TextInput, type ChangeMode } from './ui'

type Patch = Partial<SceneNode> | ((n: SceneNode) => Partial<SceneNode>)

function same<T>(nodes: SceneNode[], get: (n: SceneNode) => T): T | undefined {
  const first = get(nodes[0])
  const key = JSON.stringify(first)
  return nodes.every((n) => JSON.stringify(get(n)) === key) ? first : undefined
}

export function paintCss(p: Paint): string {
  if (p.type === 'SOLID') return cssColor(p.color, p.opacity ?? 1)
  if (p.type === 'IMAGE') return `center / cover url("${p.url}")`
  const stops = p.stops.map((s) => `${cssColor(s.color, s.opacity ?? 1)} ${s.position * 100}%`).join(', ')
  return p.type === 'GRADIENT_LINEAR' ? `linear-gradient(${(p.angle ?? 90) + 90}deg, ${stops})` : `radial-gradient(${stops})`
}

const paintLabel = (p: Paint) => (p.type === 'SOLID' ? p.color.replace('#', '') : p.type === 'IMAGE' ? 'Image' : p.type === 'GRADIENT_LINEAR' ? 'Linear' : 'Radial')

function PaintEditor({ paint, onChange }: { paint: Paint; onChange: (p: Paint, mode: ChangeMode) => void }) {
  const [stopIdx, setStopIdx] = useState(0)
  const setType = (type: Paint['type']) => {
    if (type === paint.type) return
    const base = { opacity: paint.opacity, visible: paint.visible }
    const color = paint.type === 'SOLID' ? paint.color : paint.type === 'IMAGE' ? '#D9D9D9' : paint.stops[0].color
    if (type === 'SOLID') onChange({ type, color, ...base }, 'commit')
    else if (type === 'IMAGE') onChange({ type, url: '', scaleMode: 'FILL', ...base }, 'commit')
    else
      onChange(
        {
          type,
          angle: 90,
          stops:
            paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL'
              ? paint.stops
              : [
                  { position: 0, color, opacity: 1 },
                  { position: 1, color, opacity: 0 },
                ],
          ...base,
        },
        'commit',
      )
  }
  return (
    <div className="paint-editor">
      <div className="row">
        <Select
          value={paint.type}
          onChange={setType}
          options={[
            { value: 'SOLID', label: 'Solid' },
            { value: 'GRADIENT_LINEAR', label: 'Linear gradient' },
            { value: 'GRADIENT_RADIAL', label: 'Radial gradient' },
            { value: 'IMAGE', label: 'Image' },
          ]}
        />
      </div>
      {paint.type === 'SOLID' && (
        <ColorPicker color={paint.color} opacity={paint.opacity ?? 1} onChange={(color, opacity, m) => onChange({ ...paint, color, opacity }, m)} />
      )}
      {(paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') &&
        (() => {
          const idx = Math.min(stopIdx, paint.stops.length - 1)
          const stop = paint.stops[idx]
          const setStops = (stops: typeof paint.stops, m: ChangeMode) => onChange({ ...paint, stops }, m)
          return (
            <>
              <div className="gradient-bar" style={{ background: paintCss({ ...paint, type: 'GRADIENT_LINEAR', angle: 0 }) }} />
              <div className="stops">
                {paint.stops.map((s, i) => (
                  <div key={i} className={'row stop' + (i === idx ? ' active' : '')} onClick={() => setStopIdx(i)}>
                    <span className="swatch" style={{ background: cssColor(s.color, s.opacity ?? 1) }} />
                    <NumInput
                      className="w56"
                      value={Math.round(s.position * 100)}
                      suffix="%"
                      min={0}
                      max={100}
                      onChange={(v, m) => setStops(paint.stops.map((o, j) => (j === i ? { ...o, position: v / 100 } : o)), m)}
                    />
                    <span className="grow mono">{s.color.replace('#', '')}</span>
                    {paint.stops.length > 2 && (
                      <IconBtn title="Remove stop" onClick={() => setStops(paint.stops.filter((_, j) => j !== i), 'commit')}>
                        <Minus size={14} />
                      </IconBtn>
                    )}
                  </div>
                ))}
                <div className="row">
                  <button
                    className="link-btn"
                    onClick={() =>
                      setStops([...paint.stops, { position: 0.5, color: stop.color, opacity: stop.opacity }].sort((a, b) => a.position - b.position), 'commit')
                    }
                  >
                    + Add stop
                  </button>
                  {paint.type === 'GRADIENT_LINEAR' && (
                    <NumInput
                      className="w72"
                      label={<RotateCw size={12} />}
                      title="Angle"
                      value={paint.angle ?? 90}
                      suffix="°"
                      onChange={(v, m) => onChange({ ...paint, angle: v }, m)}
                    />
                  )}
                </div>
              </div>
              <ColorPicker
                color={stop.color}
                opacity={stop.opacity ?? 1}
                onChange={(color, opacity, m) => setStops(paint.stops.map((o, j) => (j === idx ? { ...o, color, opacity } : o)), m)}
              />
            </>
          )
        })()}
      {paint.type === 'IMAGE' && (
        <div className="col">
          <div className="image-preview" style={{ background: paint.url ? paintCss(paint) : '#eee' }} />
          <TextInput value={paint.url} placeholder="Image URL" onCommit={(url) => onChange({ ...paint, url }, 'commit')} />
          <div className="row">
            <label className="link-btn">
              Upload…
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) onChange({ ...paint, url: await placeImageUrl(f) }, 'commit')
                }}
              />
            </label>
            <Select
              value={paint.scaleMode ?? 'FILL'}
              onChange={(scaleMode) => onChange({ ...paint, scaleMode }, 'commit')}
              options={[
                { value: 'FILL', label: 'Fill' },
                { value: 'FIT', label: 'Fit' },
                { value: 'STRETCH', label: 'Stretch' },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function PaintList({ nodes, prop, set, title, defaultColor, extra, header }: { nodes: SceneNode[]; prop: 'fills' | 'strokes'; set: (p: Patch, m: ChangeMode) => void; title: string; defaultColor: string; extra?: React.ReactNode; header?: React.ReactNode }) {
  const [open, setOpen] = useState<{ i: number; y: number } | null>(null)
  const paints = same(nodes, (n) => n[prop] ?? [])
  const setPaints = (list: Paint[], m: ChangeMode = 'commit') => set({ [prop]: list }, m)
  const add = () => {
    const extra: Partial<SceneNode> = prop === 'strokes' ? { strokeWeight: same(nodes, (n) => n.strokeWeight) ?? 1 } : {}
    set({ [prop]: [...(paints ?? []), { type: 'SOLID', color: defaultColor }], ...extra }, 'commit')
  }
  return (
    <Section
      title={title}
      actions={
        <>
          {extra}
          <IconBtn title={`Add ${title.toLowerCase()}`} onClick={add}>
            <Plus size={14} />
          </IconBtn>
        </>
      }
    >
      {header}
      {paints === undefined && <div className="hint">Click + to replace mixed content</div>}
      {[...(paints ?? [])].map((_, k, arr) => {
        // Top-most paint first, like Figma.
        const i = arr.length - 1 - k
        const p = arr[i]
        const patchAt = (np: Paint, m: ChangeMode) => setPaints(arr.map((o, j) => (j === i ? np : o)), m)
        return (
          <div className={'row paint-row' + (p.visible === false ? ' muted' : '')} key={i}>
            <button className="swatch checker" onClick={(e) => setOpen({ i, y: e.clientY })}>
              <span style={{ background: paintCss(p) }} />
            </button>
            {p.type === 'SOLID' ? (
              <TextInput
                className="grow mono"
                value={paintLabel(p)}
                onCommit={(v) => {
                  const hex = normalizeHex(v)
                  if (hex) patchAt({ ...p, color: hex }, 'commit')
                }}
              />
            ) : (
              <span className="grow paint-label" onClick={(e) => setOpen({ i, y: e.clientY })}>
                {paintLabel(p)}
              </span>
            )}
            <NumInput className="w48 bare" value={Math.round((p.opacity ?? 1) * 100)} suffix="%" min={0} max={100} onChange={(v, m) => patchAt({ ...p, opacity: v / 100 }, m)} />
            <IconBtn title="Toggle visibility" onClick={() => patchAt({ ...p, visible: p.visible === false }, 'commit')}>
              {p.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconBtn>
            <IconBtn title="Remove" onClick={() => setPaints(arr.filter((_, j) => j !== i))}>
              <Minus size={14} />
            </IconBtn>
            {open?.i === i && (
              <Popover anchorY={open.y} onClose={() => setOpen(null)} title={title}>
                <PaintEditor paint={p} onChange={patchAt} />
              </Popover>
            )}
          </div>
        )
      })}
    </Section>
  )
}

function ColorField({ color, opacity, onChange }: { color: string; opacity: number; onChange: (c: string, o: number, m: ChangeMode) => void }) {
  const [y, setY] = useState<number | null>(null)
  return (
    <>
      <button className="swatch checker" onClick={(e) => setY(e.clientY)}>
        <span style={{ background: cssColor(color, opacity) }} />
      </button>
      {y !== null && (
        <Popover anchorY={y} onClose={() => setY(null)} title="Color">
          <ColorPicker color={color} opacity={opacity} onChange={onChange} />
        </Popover>
      )}
    </>
  )
}

function Effects({ nodes, set }: { nodes: SceneNode[]; set: (p: Patch, m: ChangeMode) => void }) {
  const effects = same(nodes, (n) => n.effects ?? [])
  const setFx = (list: Effect[], m: ChangeMode = 'commit') => set({ effects: list }, m)
  return (
    <Section
      title="Effects"
      actions={
        <IconBtn
          title="Add effect"
          onClick={() => setFx([...(effects ?? []), { type: 'DROP_SHADOW', color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 4, spread: 0 }])}
        >
          <Plus size={14} />
        </IconBtn>
      }
    >
      {effects === undefined && <div className="hint">Click + to replace mixed content</div>}
      {(effects ?? []).map((e, i, arr) => {
        const patchAt = (ne: Effect, m: ChangeMode) => setFx(arr.map((o, j) => (j === i ? ne : o)), m)
        const shadow = e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'
        return (
          <div key={i} className={'effect' + (e.visible === false ? ' muted' : '')}>
            <div className="row">
              <Select
                className="grow"
                value={e.type}
                onChange={(type) => {
                  if (type === e.type) return
                  if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW')
                    patchAt(shadow ? ({ ...e, type } as Effect) : { type, color: '#000000', opacity: 0.25, x: 0, y: 4, blur: 4, spread: 0, visible: e.visible }, 'commit')
                  else patchAt({ type, radius: shadow ? 4 : (e as { radius: number }).radius, visible: e.visible }, 'commit')
                }}
                options={[
                  { value: 'DROP_SHADOW', label: 'Drop shadow' },
                  { value: 'INNER_SHADOW', label: 'Inner shadow' },
                  { value: 'LAYER_BLUR', label: 'Layer blur' },
                ]}
              />
              <IconBtn title="Toggle visibility" onClick={() => patchAt({ ...e, visible: e.visible === false }, 'commit')}>
                {e.visible === false ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconBtn>
              <IconBtn title="Remove" onClick={() => setFx(arr.filter((_, j) => j !== i))}>
                <Minus size={14} />
              </IconBtn>
            </div>
            {e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? (
              <>
                <div className="row">
                  <NumInput label="X" value={e.x} onChange={(v, m) => patchAt({ ...e, x: v }, m)} />
                  <NumInput label="Y" value={e.y} onChange={(v, m) => patchAt({ ...e, y: v }, m)} />
                </div>
                <div className="row">
                  <NumInput label="Blur" value={e.blur} min={0} onChange={(v, m) => patchAt({ ...e, blur: v }, m)} />
                  <ColorField color={e.color} opacity={e.opacity ?? 1} onChange={(color, opacity, m) => patchAt({ ...e, color, opacity }, m)} />
                  <NumInput className="w48 bare" value={Math.round((e.opacity ?? 1) * 100)} suffix="%" min={0} max={100} onChange={(v, m) => patchAt({ ...e, opacity: v / 100 }, m)} />
                </div>
              </>
            ) : (
              <div className="row">
                <NumInput label="Blur" value={(e as { radius: number }).radius} min={0} onChange={(v, m) => patchAt({ type: 'LAYER_BLUR', radius: v, visible: e.visible }, m)} />
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

const WEIGHTS = [
  { value: '100', label: 'Thin' },
  { value: '200', label: 'Extra Light' },
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semi Bold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extra Bold' },
  { value: '900', label: 'Black' },
]

function Typography({ nodes, set, real }: { nodes: SceneNode[]; set: (p: Patch, m: ChangeMode) => void; real: SceneNode[] }) {
  const lh = same(nodes, (n) => n.lineHeight ?? null)
  const hAlign = same(nodes, (n) => n.textAlignHorizontal ?? 'LEFT')
  const vAlign = same(nodes, (n) => n.textAlignVertical ?? 'TOP')
  const resize = same(nodes, (n) => n.textAutoResize ?? 'WIDTH_AND_HEIGHT')
  return (
    <Section title="Typography" actions={<StyleButton nodes={real} kind="TEXT" />}>
      <StyleChip nodes={real} kind="TEXT" />
      <div className="row">
        <Select className="grow" value={same(nodes, (n) => n.fontFamily ?? 'Inter')} onChange={(fontFamily) => set({ fontFamily }, 'commit')} options={FONTS.map((f) => ({ value: f, label: f }))} />
      </div>
      <div className="row">
        <Select className="grow" value={same(nodes, (n) => String(n.fontWeight ?? 400))} onChange={(w) => set({ fontWeight: +w }, 'commit')} options={WEIGHTS} />
        <NumInput className="w72" title="Font size" value={same(nodes, (n) => n.fontSize ?? 12)} min={1} onChange={(v, m) => set({ fontSize: v }, m)} />
      </div>
      <div className="row">
        <NumInput
          label={<span className="glyph">A͟</span>}
          title="Line height (empty = auto)"
          value={lh === null ? undefined : lh}
          placeholder={lh === null ? 'Auto' : 'Mixed'}
          min={1}
          onChange={(v, m) => set({ lineHeight: v }, m)}
        />
        <NumInput label={<span className="glyph">|A|</span>} title="Letter spacing" value={same(nodes, (n) => n.letterSpacing ?? 0)} step={0.1} suffix="px" onChange={(v, m) => set({ letterSpacing: v }, m)} />
      </div>
      {lh !== null && (
        <div className="row">
          <button className="link-btn" onClick={() => set({ lineHeight: undefined }, 'commit')}>
            Reset line height to auto
          </button>
        </div>
      )}
      <div className="row">
        <div className="seg">
          <IconBtn title="Align left" active={hAlign === 'LEFT'} onClick={() => set({ textAlignHorizontal: 'LEFT' }, 'commit')}>
            <TextAlignStart size={14} />
          </IconBtn>
          <IconBtn title="Align center" active={hAlign === 'CENTER'} onClick={() => set({ textAlignHorizontal: 'CENTER' }, 'commit')}>
            <TextAlignCenter size={14} />
          </IconBtn>
          <IconBtn title="Align right" active={hAlign === 'RIGHT'} onClick={() => set({ textAlignHorizontal: 'RIGHT' }, 'commit')}>
            <TextAlignEnd size={14} />
          </IconBtn>
        </div>
        <div className="seg">
          <IconBtn title="Align top" active={vAlign === 'TOP'} onClick={() => set({ textAlignVertical: 'TOP' }, 'commit')}>
            <AlignVerticalJustifyStart size={14} />
          </IconBtn>
          <IconBtn title="Align middle" active={vAlign === 'CENTER'} onClick={() => set({ textAlignVertical: 'CENTER' }, 'commit')}>
            <AlignVerticalJustifyCenter size={14} />
          </IconBtn>
          <IconBtn title="Align bottom" active={vAlign === 'BOTTOM'} onClick={() => set({ textAlignVertical: 'BOTTOM' }, 'commit')}>
            <AlignVerticalJustifyEnd size={14} />
          </IconBtn>
        </div>
      </div>
      <div className="row">
        <Select
          className="grow"
          title="Resizing"
          value={resize}
          onChange={(textAutoResize) => set({ textAutoResize }, 'commit')}
          options={[
            { value: 'WIDTH_AND_HEIGHT', label: 'Auto width' },
            { value: 'HEIGHT', label: 'Auto height' },
            { value: 'NONE', label: 'Fixed size' },
          ]}
        />
        <Select
          className="grow"
          title="Decoration"
          value={same(nodes, (n) => n.textDecoration ?? 'NONE')}
          onChange={(textDecoration) => set({ textDecoration }, 'commit')}
          options={[
            { value: 'NONE', label: 'No decoration' },
            { value: 'UNDERLINE', label: 'Underline' },
            { value: 'STRIKETHROUGH', label: 'Strikethrough' },
          ]}
        />
      </div>
      <div className="row">
        <Select
          className="grow"
          title="Case"
          value={same(nodes, (n) => n.textCase ?? 'ORIGINAL')}
          onChange={(textCase) => set({ textCase }, 'commit')}
          options={[
            { value: 'ORIGINAL', label: 'As typed' },
            { value: 'UPPER', label: 'UPPERCASE' },
            { value: 'LOWER', label: 'lowercase' },
            { value: 'TITLE', label: 'Title Case' },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={!!same(nodes, (n) => !!n.italic)} onChange={(e) => set({ italic: e.target.checked }, 'commit')} /> Italic
        </label>
      </div>
    </Section>
  )
}

function AutoLayout({ nodes, set }: { nodes: SceneNode[]; set: (p: Patch, m: ChangeMode) => void }) {
  const [sides, setSides] = useState(false)
  const frames = nodes.every((n) => n.type === 'FRAME')
  const al = nodes.every(isAutoLayout)
  if (!al)
    return (
      <Section
        title="Auto layout"
        actions={
          <IconBtn title="Add auto layout (Shift+A)" onClick={addAutoLayout}>
            <Plus size={14} />
          </IconBtn>
        }
      />
    )
  if (!frames) return null
  const mode = same(nodes, (n) => n.layoutMode)
  const pAlign = same(nodes, (n) => n.primaryAxisAlignItems ?? 'MIN')
  const cAlign = same(nodes, (n) => n.counterAxisAlignItems ?? 'MIN')
  const horiz = mode === 'HORIZONTAL'
  const A = ['MIN', 'CENTER', 'MAX'] as const
  const pads = nodes.some((n) => (n.paddingLeft ?? 0) !== (n.paddingRight ?? 0) || (n.paddingTop ?? 0) !== (n.paddingBottom ?? 0))
  const wrap = same(nodes, (n) => !!n.layoutWrap)
  return (
    <Section
      title="Auto layout"
      actions={
        <IconBtn title="Remove auto layout" onClick={() => nodes.forEach((n) => removeAutoLayout(n.id))}>
          <Minus size={14} />
        </IconBtn>
      }
    >
      <div className="row">
        <div className="seg">
          <IconBtn title="Vertical layout" active={mode === 'VERTICAL'} onClick={() => set({ layoutMode: 'VERTICAL' }, 'commit')}>
            <ArrowDown size={14} />
          </IconBtn>
          <IconBtn title="Horizontal layout" active={mode === 'HORIZONTAL'} onClick={() => set({ layoutMode: 'HORIZONTAL' }, 'commit')}>
            <ArrowRight size={14} />
          </IconBtn>
        </div>
        <NumInput label="Gap" title="Gap between items" value={same(nodes, (n) => n.itemSpacing ?? 0)} onChange={(v, m) => set({ itemSpacing: v }, m)} disabled={pAlign === 'SPACE_BETWEEN'} />
      </div>
      <div className="row">
        <div className="align-grid" title="Alignment">
          {A.map((rowA) =>
            A.map((colA) => {
              const p = horiz ? colA : rowA
              const c = horiz ? rowA : colA
              const active = (pAlign === p || (pAlign === 'SPACE_BETWEEN' && p === 'CENTER')) && cAlign === c
              return (
                <button
                  key={rowA + colA}
                  className={active ? 'active' : ''}
                  onClick={() => set({ primaryAxisAlignItems: pAlign === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : p, counterAxisAlignItems: c }, 'commit')}
                />
              )
            }),
          )}
        </div>
        <div className="col grow">
          <NumInput
            label="↔"
            title="Horizontal padding"
            value={same(nodes, (n) => ((n.paddingLeft ?? 0) === (n.paddingRight ?? 0) ? (n.paddingLeft ?? 0) : null)) ?? undefined}
            min={0}
            onChange={(v, m) => set({ paddingLeft: v, paddingRight: v }, m)}
          />
          <NumInput
            label="↕"
            title="Vertical padding"
            value={same(nodes, (n) => ((n.paddingTop ?? 0) === (n.paddingBottom ?? 0) ? (n.paddingTop ?? 0) : null)) ?? undefined}
            min={0}
            onChange={(v, m) => set({ paddingTop: v, paddingBottom: v }, m)}
          />
        </div>
      </div>
      {(sides || pads) && (
        <div className="row quad">
          <NumInput label="L" title="Padding left" value={same(nodes, (n) => n.paddingLeft ?? 0)} min={0} onChange={(v, m) => set({ paddingLeft: v }, m)} />
          <NumInput label="T" title="Padding top" value={same(nodes, (n) => n.paddingTop ?? 0)} min={0} onChange={(v, m) => set({ paddingTop: v }, m)} />
          <NumInput label="R" title="Padding right" value={same(nodes, (n) => n.paddingRight ?? 0)} min={0} onChange={(v, m) => set({ paddingRight: v }, m)} />
          <NumInput label="B" title="Padding bottom" value={same(nodes, (n) => n.paddingBottom ?? 0)} min={0} onChange={(v, m) => set({ paddingBottom: v }, m)} />
        </div>
      )}
      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={pAlign === 'SPACE_BETWEEN'}
            onChange={(e) => set({ primaryAxisAlignItems: e.target.checked ? 'SPACE_BETWEEN' : 'MIN' }, 'commit')}
          />{' '}
          Space between
        </label>
        {horiz && (
          <label className="check" title="Wrap children onto new rows">
            <input type="checkbox" checked={!!wrap} onChange={(e) => set({ layoutWrap: e.target.checked ? true : undefined }, 'commit')} /> Wrap
          </label>
        )}
        <IconBtn title="Individual padding" active={sides || pads} onClick={() => setSides((v) => !v)}>
          <MoreHorizontal size={14} />
        </IconBtn>
      </div>
      {horiz && wrap && (
        <div className="row">
          <NumInput label="Row gap" title="Gap between rows" value={same(nodes, (n) => n.counterAxisSpacing ?? n.itemSpacing ?? 0)} min={0} onChange={(v, m) => set({ counterAxisSpacing: v }, m)} />
        </div>
      )}
    </Section>
  )
}

export function PropertiesPanel({ fileName, onPageBg }: { fileName: string; onPageBg: (c: string) => void }) {
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const pageBg = useEditor((s) => s.pageBg)
  const [exportScale, setExportScale] = useState('1')
  const [exportFormat, setExportFormat] = useState<'PNG' | 'JPG' | 'SVG'>('PNG')
  const [radii, setRadii] = useState(false)
  const [minMax, setMinMax] = useState(false)
  const editingId = useEditor((s) => s.editingId)
  const textSel = useEditor((s) => s.textSel)
  const nodes = selection.map((id) => doc.byId.get(id)).filter((n): n is SceneNode => !!n)
  const ids = nodes.map((n) => n.id)

  if (!nodes.length)
    return (
      <div className="panel-body">
        <Section title="Page">
          <div className="row paint-row">
            <ColorField color={pageBg} opacity={1} onChange={(c, _o, m) => m === 'commit' && onPageBg(c)} />
            <TextInput
              className="grow mono"
              value={pageBg.replace('#', '')}
              onCommit={(v) => {
                const hex = normalizeHex(v)
                if (hex) onPageBg(hex)
              }}
            />
          </div>
        </Section>
        <LocalStyles />
        <Section title="Export">
          <div className="row">
            <button className="btn wide" onClick={() => exportNodes([...doc.children.get('') ?? []], 'PNG', 1, fileName)}>
              Export page as PNG
            </button>
          </div>
        </Section>
        <div className="hint pad">
          Select a layer to edit its properties. Press <b>R</b>, <b>O</b>, <b>F</b>, <b>T</b>, <b>P</b> to draw; hold <b>Space</b> to pan; <b>Ctrl</b>+scroll to zoom.
        </div>
      </div>
    )

  const allTextNodes = nodes.every((n) => n.type === 'TEXT')
  const set = (patch: Patch, mode: ChangeMode) => {
    if (typeof patch !== 'function') {
      // Editing a property by hand detaches the shared style that controlled it.
      if ('fills' in patch && nodes.some((n) => n.fillStyleId)) patch = { ...patch, fillStyleId: undefined }
      if (hasTextStyleKey(patch) && nodes.some((n) => n.textStyleId)) patch = { ...patch, textStyleId: undefined }
    }
    if (allTextNodes && typeof patch !== 'function') {
      styleText(ids, patch, mode === 'commit')
      if (mode === 'commit' && S().editingId && !(document.activeElement instanceof HTMLInputElement)) focusProxy()
      return
    }
    preview(ids, patch)
    if (mode === 'commit') commitDraft()
  }
  // While characters are selected inside a text layer, the panel shows (and edits) their style.
  const editing = editingId && textSel && nodes.length === 1 && nodes[0].id === editingId ? nodes[0] : null
  const shown = editing ? stylesInRange(editing, Math.min(textSel!.start, textSel!.end), Math.max(textSel!.start, textSel!.end)) : nodes
  const parents = nodes.map((n) => doc.byId.get(parentOf(doc, n.id)))
  const inAL = parents.every((p) => p && isAutoLayout(p))
  const flow = inAL && nodes.every((n) => n.layoutPositioning !== 'ABSOLUTE')
  const allText = nodes.every((n) => n.type === 'TEXT')
  const anyFrame = nodes.some((n) => n.type === 'FRAME')
  const hasCorners = nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME')
  const noPaint = nodes.every((n) => n.type === 'GROUP' && !n.booleanOp)
  const header = nodes.length === 1 ? nodeLabel(nodes[0]) : `${nodes.length} selected`
  const boolOp = nodes.every((n) => n.booleanOp) ? same(nodes, (n) => n.booleanOp) : null
  const lockRatio = same(nodes, (n) => !!n.constrainProportions)
  const ratioSize = (n: SceneNode, k: 'width' | 'height', v: number): Partial<SceneNode> => {
    if (!n.constrainProportions || !n.width || !n.height || n.type === 'LINE') return {}
    return k === 'width' ? { height: Math.max(1, Math.round(((v * n.height) / n.width) * 100) / 100) } : { width: Math.max(1, Math.round(((v * n.width) / n.height) * 100) / 100) }
  }

  const sizingOptions = (axis: 'H' | 'V'): { value: Sizing; label: string }[] => {
    const opts: { value: Sizing; label: string }[] = [{ value: 'FIXED', label: 'Fixed' }]
    if (nodes.every((n) => isAutoLayout(n) || n.type === 'TEXT')) opts.push({ value: 'HUG', label: 'Hug' })
    if (inAL) opts.push({ value: 'FILL', label: 'Fill' })
    void axis
    return opts
  }
  const setSizing = (axis: 'H' | 'V', v: Sizing) =>
    update(ids, (n) => {
      const p: Partial<SceneNode> = axis === 'H' ? { layoutSizingHorizontal: v } : { layoutSizingVertical: v }
      if (n.type === 'TEXT') {
        const other = axis === 'H' ? (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') : null
        if (axis === 'H') p.textAutoResize = v === 'HUG' ? 'WIDTH_AND_HEIGHT' : other === 'NONE' ? 'NONE' : 'HEIGHT'
        else p.textAutoResize = v === 'HUG' ? ((n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'NONE' ? 'HEIGHT' : n.textAutoResize) : 'NONE'
      }
      return p
    })
  const sizingOf = (n: SceneNode, axis: 'H' | 'V'): Sizing => {
    const s = axis === 'H' ? n.layoutSizingHorizontal : n.layoutSizingVertical
    if (s === 'FILL' && inAL) return 'FILL'
    if (n.type === 'TEXT') {
      const mode = n.textAutoResize ?? 'WIDTH_AND_HEIGHT'
      return axis === 'H' ? (mode === 'WIDTH_AND_HEIGHT' ? 'HUG' : 'FIXED') : mode === 'NONE' ? 'FIXED' : 'HUG'
    }
    return s === 'HUG' && isAutoLayout(n) ? 'HUG' : 'FIXED'
  }

  return (
    <div className="panel-body">
      <div className="node-header">
        <span className="grow">{header}</span>
        {boolOp !== null && (
          <Select
            title="Boolean operation"
            value={boolOp}
            onChange={(op: BooleanOp) => booleanOperation(op)}
            options={[
              { value: 'UNION', label: 'Union' },
              { value: 'SUBTRACT', label: 'Subtract' },
              { value: 'INTERSECT', label: 'Intersect' },
              { value: 'EXCLUDE', label: 'Exclude' },
            ]}
          />
        )}
      </div>
      <ComponentSection nodes={nodes} />
      <Section title="Position">
        <div className="row align-row">
          <IconBtn title="Align left (Alt+A)" onClick={() => alignSelection('left')}><AlignStartVertical size={14} /></IconBtn>
          <IconBtn title="Align horizontal centers (Alt+H)" onClick={() => alignSelection('hcenter')}><AlignCenterVertical size={14} /></IconBtn>
          <IconBtn title="Align right (Alt+D)" onClick={() => alignSelection('right')}><AlignEndVertical size={14} /></IconBtn>
          <IconBtn title="Align top (Alt+W)" onClick={() => alignSelection('top')}><AlignStartHorizontal size={14} /></IconBtn>
          <IconBtn title="Align vertical centers (Alt+V)" onClick={() => alignSelection('vcenter')}><AlignCenterHorizontal size={14} /></IconBtn>
          <IconBtn title="Align bottom (Alt+S)" onClick={() => alignSelection('bottom')}><AlignEndHorizontal size={14} /></IconBtn>
          <IconBtn title="Distribute horizontal spacing" disabled={nodes.length < 3} onClick={() => distributeSelection('h')}><AlignHorizontalSpaceAround size={14} /></IconBtn>
          <IconBtn title="Distribute vertical spacing" disabled={nodes.length < 3} onClick={() => distributeSelection('v')}><AlignVerticalSpaceAround size={14} /></IconBtn>
        </div>
        <div className="row">
          <NumInput label="X" value={same(nodes, (n) => n.x)} disabled={flow} onChange={(v, m) => set({ x: v }, m)} />
          <NumInput label="Y" value={same(nodes, (n) => n.y)} disabled={flow} onChange={(v, m) => set({ y: v }, m)} />
        </div>
        <div className="row">
          <NumInput label={<RotateCw size={12} />} title="Rotation" value={same(nodes, (n) => n.rotation ?? 0)} suffix="°" onChange={(v, m) => set({ rotation: v }, m)} />
          {inAL ? (
            <label className="check" title="Ignore auto layout">
              <input
                type="checkbox"
                checked={!flow}
                onChange={(e) => set({ layoutPositioning: e.target.checked ? 'ABSOLUTE' : 'AUTO' }, 'commit')}
              />{' '}
              Absolute
            </label>
          ) : (
            <span className="grow" />
          )}
        </div>
      </Section>

      <Section title="Layout">
        <div className="row">
          <NumInput label="W" value={same(nodes, (n) => n.width)} min={0} onChange={(v, m) => set((n) => ({ width: Math.max(n.type === 'LINE' ? 0 : 1, v), ...ratioSize(n, 'width', v), ...sizeSideEffects(n, true, !!n.constrainProportions) }), m)} />
          <NumInput label="H" value={same(nodes, (n) => n.height)} min={0} onChange={(v, m) => set((n) => (n.type === 'LINE' ? {} : { height: Math.max(1, v), ...ratioSize(n, 'height', v), ...sizeSideEffects(n, !!n.constrainProportions, true) }), m)} />
          <IconBtn title="Lock aspect ratio" active={!!lockRatio} onClick={() => set({ constrainProportions: lockRatio ? undefined : true }, 'commit')}>
            <Link2 size={13} />
          </IconBtn>
          <IconBtn title="Min / max size" active={minMax || nodes.some((n) => n.minWidth != null || n.maxWidth != null || n.minHeight != null || n.maxHeight != null)} onClick={() => setMinMax((v) => !v)}>
            <MoreHorizontal size={13} />
          </IconBtn>
        </div>
        {(minMax || nodes.some((n) => n.minWidth != null || n.maxWidth != null || n.minHeight != null || n.maxHeight != null)) && (
          <div className="row quad">
            {(['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).map((k) => (
              <NumInput
                key={k}
                label={k.startsWith('min') ? 'Min' : 'Max'}
                title={k.replace(/([WH])/, ' $1').toLowerCase() + ' (0 = none)'}
                value={same(nodes, (n) => n[k] ?? 0)}
                min={0}
                onChange={(v, m) => set({ [k]: v > 0 ? v : undefined }, m)}
              />
            ))}
          </div>
        )}
        {(inAL || nodes.every((n) => isAutoLayout(n) || n.type === 'TEXT')) && (
          <div className="row">
            <Select className="grow" title="Horizontal resizing" value={same(nodes, (n) => sizingOf(n, 'H'))} options={sizingOptions('H')} onChange={(v) => setSizing('H', v)} />
            <Select className="grow" title="Vertical resizing" value={same(nodes, (n) => sizingOf(n, 'V'))} options={sizingOptions('V')} onChange={(v) => setSizing('V', v)} />
          </div>
        )}
        {anyFrame && (
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={!!same(nodes, (n) => n.clipsContent !== false)} onChange={(e) => set({ clipsContent: e.target.checked }, 'commit')} /> Clip content
            </label>
          </div>
        )}
      </Section>

      <ConstraintsSection nodes={nodes} set={set} />
      {!nodes.some((n) => n.booleanOp || n.sourceId || n.componentId) || nodes.every(isAutoLayout) ? <AutoLayout nodes={nodes} set={set} /> : null}
      <GridSection nodes={nodes} set={set} />

      <Section title="Appearance">
        <div className="row">
          <NumInput label={<Eye size={12} />} title="Opacity" value={same(nodes, (n) => Math.round((n.opacity ?? 1) * 100))} suffix="%" min={0} max={100} onChange={(v, m) => set({ opacity: v / 100 }, m)} />
          {hasCorners ? (
            <>
              <NumInput label={<Scan size={12} />} title="Corner radius" value={same(nodes, (n) => (n.cornerRadii ? -1 : (n.cornerRadius ?? 0))) === -1 ? undefined : same(nodes, (n) => n.cornerRadius ?? 0)} min={0} onChange={(v, m) => set({ cornerRadius: v, cornerRadii: undefined }, m)} />
              <IconBtn title="Individual corners" active={radii || nodes.some((n) => n.cornerRadii)} onClick={() => setRadii((v) => !v)}>
                <SquareRoundCorner size={13} />
              </IconBtn>
            </>
          ) : nodes.every((n) => n.type === 'POLYGON' || n.type === 'STAR') ? (
            <NumInput label="N" title="Point count" value={same(nodes, (n) => n.pointCount ?? 3)} min={3} max={60} onChange={(v, m) => set({ pointCount: Math.round(v) }, m)} />
          ) : (
            <span className="grow" />
          )}
        </div>
        {hasCorners && (radii || nodes.some((n) => n.cornerRadii)) && (
          <div className="row quad">
            {[0, 1, 2, 3].map((i) => (
              <NumInput
                key={i}
                title={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' radius'}
                label={['↖', '↗', '↘', '↙'][i]}
                value={same(nodes, (n) => (n.cornerRadii ?? [n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0])[i])}
                min={0}
                onChange={(v, m) =>
                  set((n) => {
                    const r = [...(n.cornerRadii ?? [n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0, n.cornerRadius ?? 0])] as [number, number, number, number]
                    r[i] = v
                    return r.every((x) => x === r[0]) ? { cornerRadius: r[0], cornerRadii: undefined } : { cornerRadii: r }
                  }, m)
                }
              />
            ))}
          </div>
        )}
        {nodes.every((n) => n.type === 'STAR') && (
          <div className="row">
            <NumInput label="Ratio" title="Inner radius" value={same(nodes, (n) => Math.round((n.starInnerRadius ?? 0.382) * 100))} suffix="%" min={1} max={100} onChange={(v, m) => set({ starInnerRadius: v / 100 }, m)} />
          </div>
        )}
        <div className="row">
          <Select
            className="grow"
            title="Blend mode"
            value={same(nodes, (n) => n.blendMode ?? 'NORMAL')}
            onChange={(blendMode) => set({ blendMode }, 'commit')}
            options={['NORMAL', 'MULTIPLY', 'SCREEN', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'COLOR_DODGE', 'COLOR_BURN', 'HARD_LIGHT', 'SOFT_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'].map(
              (b) => ({ value: b, label: b[0] + b.slice(1).toLowerCase().replace(/_/g, ' ') }),
            )}
          />
        </div>
      </Section>

      {allText && <Typography nodes={shown} set={set} real={nodes} />}

      {!noPaint && (
        <PaintList
          nodes={allText ? shown : nodes}
          prop="fills"
          title="Fill"
          set={set}
          defaultColor="#D9D9D9"
          extra={<StyleButton nodes={nodes} kind="PAINT" />}
          header={<StyleChip nodes={nodes} kind="PAINT" />}
        />
      )}
      {!noPaint && (
        <>
          <PaintList nodes={nodes} prop="strokes" title="Stroke" set={set} defaultColor="#000000" />
          {nodes.some((n) => (n.strokes ?? []).length > 0) && (
            <div className="section-extra">
              <div className="row">
                <NumInput label="Weight" value={same(nodes, (n) => n.strokeWeight ?? 1)} min={0} step={0.5} onChange={(v, m) => set({ strokeWeight: v }, m)} />
                <Select
                  className="grow"
                  title="Stroke position"
                  value={same(nodes, (n) => n.strokeAlign ?? 'INSIDE')}
                  onChange={(strokeAlign) => set({ strokeAlign }, 'commit')}
                  options={[
                    { value: 'INSIDE', label: 'Inside' },
                    { value: 'CENTER', label: 'Center' },
                    { value: 'OUTSIDE', label: 'Outside' },
                  ]}
                />
              </div>
              <div className="row">
                <NumInput label="Dash" title="Dash length (0 = solid)" value={same(nodes, (n) => n.dashPattern?.[0] ?? 0)} min={0} onChange={(v, m) => set({ dashPattern: v > 0 ? [v, v] : undefined }, m)} />
                <Select
                  className="grow"
                  title="Line cap"
                  value={same(nodes, (n) => n.strokeCap ?? 'NONE')}
                  onChange={(strokeCap) => set({ strokeCap }, 'commit')}
                  options={[
                    { value: 'NONE', label: 'Butt cap' },
                    { value: 'ROUND', label: 'Round cap' },
                    { value: 'SQUARE', label: 'Square cap' },
                  ]}
                />
              </div>
              {nodes.every((n) => n.type === 'LINE') && (
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={!!same(nodes, (n) => !!n.arrowStart)} onChange={(e) => set({ arrowStart: e.target.checked ? true : undefined }, 'commit')} /> Start arrow
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={!!same(nodes, (n) => !!n.arrowEnd)} onChange={(e) => set({ arrowEnd: e.target.checked ? true : undefined }, 'commit')} /> End arrow
                  </label>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <Effects nodes={nodes} set={set} />

      <Section title="Export">
        <div className="row">
          <Select className="w72" value={exportScale} onChange={setExportScale} options={['0.5', '1', '2', '3', '4'].map((s) => ({ value: s, label: s + 'x' }))} />
          <Select className="grow" value={exportFormat} onChange={setExportFormat} options={[{ value: 'PNG', label: 'PNG' }, { value: 'JPG', label: 'JPG' }, { value: 'SVG', label: 'SVG' }]} />
        </div>
        <div className="row">
          <button className="btn wide" onClick={() => exportNodes(ids, exportFormat, +exportScale, fileName)}>
            Export {nodes.length === 1 ? nodes[0].name : `${nodes.length} layers`}
          </button>
        </div>
      </Section>
    </div>
  )
}
