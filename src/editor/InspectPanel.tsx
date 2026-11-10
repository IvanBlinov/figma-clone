import { useState } from 'react'
import { cssOf } from '../../shared/css'
import { descendants } from '../../shared/doc'
import { visiblePaints } from '../../shared/paths'
import { nodeLabel, type SceneNode } from '../../shared/types'
import { useEditor } from './store'
import { Section } from './ui'

function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="link-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/** Read-only developer view: measurements, CSS and the colours used by the selection. */
export function InspectPanel() {
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const n: SceneNode | undefined = selection.length === 1 ? doc.byId.get(selection[0]) : undefined
  if (!n)
    return (
      <div className="panel-body">
        <div className="hint pad">Select a single layer to see its measurements and CSS. Hold <b>Alt</b> and hover another layer to measure distances on the canvas.</div>
      </div>
    )
  const css = cssOf(doc, n)
  const text = css.map(([k, v]) => `${k}: ${v};`).join('\n')
  const colors = new Map<string, number>()
  for (const id of [n.id, ...descendants(doc, n.id)]) {
    const d = doc.byId.get(id)!
    for (const p of [...visiblePaints(d.fills), ...visiblePaints(d.strokes)]) if (p.type === 'SOLID') colors.set(p.color, (colors.get(p.color) ?? 0) + 1)
  }
  const r = (v: number) => Math.round(v * 100) / 100
  return (
    <div className="panel-body">
      <div className="node-header">{nodeLabel(n)}</div>
      <Section title="Layer">
        <div className="kv">
          <span>Name</span>
          <b className="ellipsis">{n.name}</b>
          <span>Position</span>
          <b>
            {r(n.x)}, {r(n.y)}
          </b>
          <span>Size</span>
          <b>
            {r(n.width)} × {r(n.height)}
          </b>
          {n.rotation ? (
            <>
              <span>Rotation</span>
              <b>{n.rotation}°</b>
            </>
          ) : null}
          <span>Id</span>
          <b className="mono ellipsis">{n.id}</b>
        </div>
      </Section>
      {n.type === 'TEXT' && (
        <Section title="Content" actions={<CopyBtn text={n.characters ?? ''} />}>
          <pre className="code plain">{n.characters}</pre>
        </Section>
      )}
      <Section title="CSS" actions={<CopyBtn text={text} />}>
        <pre className="code">
          {css.map(([k, v]) => (
            <div key={k}>
              <span className="c-prop">{k}</span>: <span className="c-val">{v}</span>;
            </div>
          ))}
        </pre>
      </Section>
      {colors.size > 0 && (
        <Section title="Colors">
          {[...colors.entries()].slice(0, 24).map(([c, count]) => (
            <div className="row paint-row" key={c}>
              <span className="swatch">
                <span style={{ background: c }} />
              </span>
              <span className="grow mono">{c}</span>
              <span className="dim">{count}×</span>
              <CopyBtn text={c} />
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}
