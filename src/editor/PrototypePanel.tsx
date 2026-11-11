import { Minus, Play, Plus } from 'lucide-react'
import { screenFrames } from '../../shared/doc'
import type { Reaction, SceneNode } from '../../shared/types'
import { topFrameOf, update } from './actions'
import { useEditor } from './store'
import { IconBtn, NumInput, Section, Select, TextInput } from './ui'

const TRIGGERS: { value: Reaction['trigger']; label: string }[] = [
  { value: 'ON_CLICK', label: 'On click' },
  { value: 'ON_HOVER', label: 'While hovering' },
  { value: 'ON_PRESS', label: 'While pressing' },
  { value: 'AFTER_TIMEOUT', label: 'After delay' },
]
const ACTIONS: { value: Reaction['action']; label: string }[] = [
  { value: 'NAVIGATE', label: 'Navigate to' },
  { value: 'OVERLAY', label: 'Open overlay' },
  { value: 'CLOSE_OVERLAY', label: 'Close overlay' },
  { value: 'BACK', label: 'Back' },
  { value: 'URL', label: 'Open link' },
]
const TRANSITIONS: { value: NonNullable<Reaction['transition']>; label: string }[] = [
  { value: 'INSTANT', label: 'Instant' },
  { value: 'DISSOLVE', label: 'Dissolve' },
  { value: 'SMART_ANIMATE', label: 'Smart animate' },
  { value: 'MOVE_IN', label: 'Move in' },
  { value: 'PUSH', label: 'Push' },
  { value: 'SLIDE_IN', label: 'Slide in' },
]

export function PrototypePanel({ onPresent }: { onPresent: (frameId?: string) => void }) {
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const frames = screenFrames(doc).map((id) => doc.byId.get(id)!)
  const flows = frames.filter((f) => f.flowStart)
  const n: SceneNode | undefined = selection.length === 1 ? doc.byId.get(selection[0]) : undefined

  if (!n)
    return (
      <div className="panel-body">
        <Section title="Flows">
          {flows.length === 0 && <div className="hint">No flow starting points yet. Select a top-level frame to add one.</div>}
          {flows.map((f) => (
            <div className="row" key={f.id}>
              <span className="grow ellipsis">{f.flowStart}</span>
              <span className="dim ellipsis">{f.name}</span>
              <IconBtn title="Present this flow" onClick={() => onPresent(f.id)}>
                <Play size={13} />
              </IconBtn>
            </div>
          ))}
          <div className="row">
            <button className="btn wide" disabled={!frames.length} onClick={() => onPresent()}>
              Present
            </button>
          </div>
        </Section>
        <div className="hint pad">
          {selection.length > 1
            ? 'Select a single layer to edit its interactions.'
            : 'Select a layer, then drag the ⊕ handle on its right edge onto a frame to connect them — or add an interaction here.'}
        </div>
      </div>
    )

  const reactions = n.reactions ?? []
  const put = (list: Reaction[]) => update([n.id], { reactions: list.length ? list : undefined })
  const at = (i: number, patch: Partial<Reaction>) => put(reactions.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const own = topFrameOf(n.id)
  const dests = frames.filter((f) => f.id !== n.id).map((f) => ({ value: f.id, label: f.name + (f.id === own ? ' (this frame)' : '') }))
  const isTop = frames.some((f) => f.id === n.id)
  const add = () => {
    const dest = dests.find((d) => d.value !== own)?.value
    put([...reactions, { trigger: reactions.some((r) => r.trigger === 'ON_CLICK') ? 'ON_HOVER' : 'ON_CLICK', action: dest ? 'NAVIGATE' : 'BACK', destinationId: dest, transition: 'DISSOLVE', duration: 300, easing: 'EASE_OUT' }])
  }

  return (
    <div className="panel-body">
      <div className="node-header">{n.name}</div>
      {isTop && (
        <Section
          title="Flow starting point"
          actions={
            n.flowStart ? (
              <IconBtn title="Remove starting point" onClick={() => update([n.id], { flowStart: undefined })}>
                <Minus size={14} />
              </IconBtn>
            ) : (
              <IconBtn title="Add starting point" onClick={() => update([n.id], { flowStart: `Flow ${flows.length + 1}` })}>
                <Plus size={14} />
              </IconBtn>
            )
          }
        >
          {n.flowStart && (
            <div className="row">
              <TextInput className="grow" value={n.flowStart} onCommit={(v) => v.trim() && update([n.id], { flowStart: v.trim() })} />
              <IconBtn title="Present from here" onClick={() => onPresent(n.id)}>
                <Play size={13} />
              </IconBtn>
            </div>
          )}
        </Section>
      )}
      <Section
        title="Interactions"
        actions={
          <IconBtn title="Add interaction" onClick={add}>
            <Plus size={14} />
          </IconBtn>
        }
      >
        {reactions.length === 0 && <div className="hint">Drag the ⊕ handle on the canvas to a frame, or click + to add an interaction.</div>}
        {reactions.map((r, i) => {
          const needsDest = r.action === 'NAVIGATE' || r.action === 'OVERLAY'
          const animated = needsDest && (r.transition ?? 'INSTANT') !== 'INSTANT'
          const directional = r.transition === 'MOVE_IN' || r.transition === 'PUSH' || r.transition === 'SLIDE_IN'
          return (
            <div className="effect" key={i}>
              <div className="row">
                <Select className="grow" value={r.trigger} options={TRIGGERS} onChange={(trigger) => at(i, { trigger, ...(trigger === 'AFTER_TIMEOUT' ? { timeout: r.timeout ?? 800 } : {}) })} />
                <IconBtn title="Remove interaction" onClick={() => put(reactions.filter((_, j) => j !== i))}>
                  <Minus size={14} />
                </IconBtn>
              </div>
              {r.trigger === 'AFTER_TIMEOUT' && (
                <div className="row">
                  <NumInput label="Delay" value={r.timeout ?? 800} suffix="ms" min={0} step={50} onChange={(v, m) => m === 'commit' && at(i, { timeout: v })} />
                </div>
              )}
              <div className="row">
                <Select className="grow" value={r.action} options={ACTIONS} onChange={(action) => at(i, { action, ...(action === 'NAVIGATE' || action === 'OVERLAY' ? { destinationId: r.destinationId ?? dests[0]?.value } : {}) })} />
              </div>
              {needsDest && (
                <div className="row">
                  <Select className="grow" title="Destination" value={r.destinationId && doc.byId.has(r.destinationId) ? r.destinationId : undefined} options={dests} onChange={(destinationId) => at(i, { destinationId })} />
                </div>
              )}
              {r.action === 'URL' && (
                <div className="row">
                  <TextInput className="grow" value={r.url ?? ''} placeholder="https://…" onCommit={(url) => at(i, { url })} />
                </div>
              )}
              {needsDest && (
                <div className="row">
                  <Select className="grow" title="Animation" value={r.transition ?? 'INSTANT'} options={TRANSITIONS} onChange={(transition) => at(i, { transition, direction: r.direction ?? 'LEFT', duration: r.duration ?? 300 })} />
                  {directional && (
                    <Select
                      title="Direction"
                      value={r.direction ?? 'LEFT'}
                      onChange={(direction) => at(i, { direction })}
                      options={[
                        { value: 'LEFT', label: '←' },
                        { value: 'RIGHT', label: '→' },
                        { value: 'TOP', label: '↑' },
                        { value: 'BOTTOM', label: '↓' },
                      ]}
                    />
                  )}
                </div>
              )}
              {animated && (
                <div className="row">
                  <Select
                    className="grow"
                    title="Easing"
                    value={r.easing ?? 'EASE_OUT'}
                    onChange={(easing) => at(i, { easing })}
                    options={[
                      { value: 'LINEAR', label: 'Linear' },
                      { value: 'EASE_IN', label: 'Ease in' },
                      { value: 'EASE_OUT', label: 'Ease out' },
                      { value: 'EASE_IN_OUT', label: 'Ease in and out' },
                    ]}
                  />
                  <NumInput className="w72" title="Duration" value={r.duration ?? 300} suffix="ms" min={0} step={50} onChange={(v, m) => m === 'commit' && at(i, { duration: v })} />
                </div>
              )}
            </div>
          )
        })}
      </Section>
    </div>
  )
}
