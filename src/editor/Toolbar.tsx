import { ChevronDown, Circle, Frame, Hand, Image as ImageIcon, MessageCircle, Minus, MousePointer2, MoveUpRight, Pencil, PenTool, Redo2, Square, Star, Triangle, Type, Undo2 } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { placeImage } from './actions'
import { redo, setTool, undo, useEditor, type Tool } from './store'

interface Item {
  tool: Tool
  label: string
  key: string
  icon: ReactNode
}

const I = { size: 18, strokeWidth: 1.6 }
const MOVE: Item[] = [
  { tool: 'move', label: 'Move', key: 'V', icon: <MousePointer2 {...I} /> },
  { tool: 'hand', label: 'Hand tool', key: 'H', icon: <Hand {...I} /> },
]
const SHAPES: Item[] = [
  { tool: 'rectangle', label: 'Rectangle', key: 'R', icon: <Square {...I} /> },
  { tool: 'line', label: 'Line', key: 'L', icon: <Minus {...I} /> },
  { tool: 'arrow', label: 'Arrow', key: 'Shift+L', icon: <MoveUpRight {...I} /> },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: <Circle {...I} /> },
  { tool: 'polygon', label: 'Polygon', key: '', icon: <Triangle {...I} /> },
  { tool: 'star', label: 'Star', key: '', icon: <Star {...I} /> },
]

const DRAW: Item[] = [
  { tool: 'pen', label: 'Pen', key: 'P', icon: <PenTool {...I} /> },
  { tool: 'pencil', label: 'Pencil', key: 'Shift+P', icon: <Pencil {...I} /> },
]

function Group({ items, extra }: { items: Item[]; extra?: ReactNode }) {
  const tool = useEditor((s) => s.tool)
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState(items[0].tool)
  const current = items.find((i) => i.tool === tool) ?? items.find((i) => i.tool === last)!
  const active = items.some((i) => i.tool === tool)
  return (
    <div className="tool-group">
      <button className={'tool' + (active ? ' active' : '')} title={`${current.label}${current.key ? ` (${current.key})` : ''}`} onClick={() => setTool(current.tool)}>
        {current.icon}
      </button>
      <button className={'tool-caret' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)} title="More tools">
        <ChevronDown size={10} />
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onPointerDown={() => setOpen(false)} />
          <div className="tool-menu">
            {items.map((i) => (
              <button
                key={i.tool}
                className={i.tool === tool ? 'active' : ''}
                onClick={() => {
                  setTool(i.tool)
                  setLast(i.tool)
                  setOpen(false)
                }}
              >
                {i.icon}
                <span className="grow">{i.label}</span>
                <kbd>{i.key}</kbd>
              </button>
            ))}
            {extra && <div onClick={() => setOpen(false)}>{extra}</div>}
          </div>
        </>
      )}
    </div>
  )
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool)
  const canUndo = useEditor((s) => s.canUndo)
  const canRedo = useEditor((s) => s.canRedo)
  const file = useRef<HTMLInputElement>(null)
  const single = (t: Tool, label: string, key: string, icon: ReactNode) => (
    <button className={'tool' + (tool === t ? ' active' : '')} title={`${label} (${key})`} onClick={() => setTool(t)}>
      {icon}
    </button>
  )
  return (
    <div className="toolbar">
      <Group items={MOVE} />
      {single('frame', 'Frame', 'F', <Frame {...I} />)}
      <Group
        items={SHAPES}
        extra={
          <button onClick={() => file.current?.click()}>
            <ImageIcon {...I} />
            <span className="grow">Image…</span>
            <kbd>Ctrl+Shift+K</kbd>
          </button>
        }
      />
      <Group items={DRAW} />
      {single('text', 'Text', 'T', <Type {...I} />)}
      {single('comment', 'Comment', 'C', <MessageCircle {...I} />)}
      <div className="tool-sep" />
      <button className="tool" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 {...I} />
      </button>
      <button className="tool" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 {...I} />
      </button>
      <input
        id="image-file-input"
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          for (const f of Array.from(e.target.files ?? [])) void placeImage(f, undefined, f.name.replace(/\.\w+$/, ''))
          e.target.value = ''
        }}
      />
    </div>
  )
}
