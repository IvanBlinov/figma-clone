import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addAutoLayout,
  alignSelection,
  booleanOperation,
  combineAsVariants,
  copyAs,
  createComponent,
  deleteSelection,
  detachInstances,
  distributeSelection,
  duplicateSelection,
  flattenSelection,
  goToMainComponent,
  reorderSelection,
  resetOverrides,
  selectAll,
  toggleMask,
  toggleTextStyle,
  ungroupSelection,
  update,
  wrapSelection,
  zoomAt,
  zoomToFit,
  zoomToNodes,
} from './actions'
import { exportNodes } from './export'
import { patchState, redo, S, setTool, undo, type Tool } from './store'

export interface Command {
  label: string
  kbd?: string
  run: () => void
}

export function buildCommands(extra: Command[]): Command[] {
  const tool = (t: Tool, label: string, kbd: string): Command => ({ label: `Tool: ${label}`, kbd, run: () => setTool(t) })
  const sel = () => S().selection
  return [
    ...extra,
    tool('move', 'Move', 'V'),
    tool('hand', 'Hand', 'H'),
    tool('frame', 'Frame', 'F'),
    tool('rectangle', 'Rectangle', 'R'),
    tool('ellipse', 'Ellipse', 'O'),
    tool('line', 'Line', 'L'),
    tool('arrow', 'Arrow', 'Shift+L'),
    tool('polygon', 'Polygon', ''),
    tool('star', 'Star', ''),
    tool('pen', 'Pen', 'P'),
    tool('pencil', 'Pencil', 'Shift+P'),
    tool('text', 'Text', 'T'),
    tool('comment', 'Comment', 'C'),
    { label: 'Undo', kbd: 'Ctrl+Z', run: undo },
    { label: 'Redo', kbd: 'Ctrl+Shift+Z', run: redo },
    { label: 'Select all', kbd: 'Ctrl+A', run: selectAll },
    { label: 'Duplicate', kbd: 'Ctrl+D', run: duplicateSelection },
    { label: 'Delete', kbd: 'Del', run: deleteSelection },
    { label: 'Group selection', kbd: 'Ctrl+G', run: () => wrapSelection('GROUP') },
    { label: 'Frame selection', kbd: 'Ctrl+Alt+G', run: () => wrapSelection('FRAME') },
    { label: 'Ungroup', kbd: 'Ctrl+Shift+G', run: ungroupSelection },
    { label: 'Add auto layout', kbd: 'Shift+A', run: addAutoLayout },
    { label: 'Create component', kbd: 'Ctrl+Alt+K', run: createComponent },
    { label: 'Combine as variants', run: combineAsVariants },
    { label: 'Detach instance', kbd: 'Ctrl+Alt+B', run: detachInstances },
    { label: 'Reset instance overrides', run: resetOverrides },
    { label: 'Go to main component', run: goToMainComponent },
    { label: 'Boolean: Union selection', run: () => booleanOperation('UNION') },
    { label: 'Boolean: Subtract selection', run: () => booleanOperation('SUBTRACT') },
    { label: 'Boolean: Intersect selection', run: () => booleanOperation('INTERSECT') },
    { label: 'Boolean: Exclude selection', run: () => booleanOperation('EXCLUDE') },
    { label: 'Flatten selection', kbd: 'Ctrl+E', run: flattenSelection },
    { label: 'Use as mask', kbd: 'Ctrl+Alt+M', run: toggleMask },
    { label: 'Bring to front', kbd: ']', run: () => reorderSelection('front') },
    { label: 'Send to back', kbd: '[', run: () => reorderSelection('back') },
    { label: 'Bring forward', kbd: 'Ctrl+]', run: () => reorderSelection('forward') },
    { label: 'Send backward', kbd: 'Ctrl+[', run: () => reorderSelection('backward') },
    { label: 'Align left', kbd: 'Alt+A', run: () => alignSelection('left') },
    { label: 'Align horizontal centers', kbd: 'Alt+H', run: () => alignSelection('hcenter') },
    { label: 'Align right', kbd: 'Alt+D', run: () => alignSelection('right') },
    { label: 'Align top', kbd: 'Alt+W', run: () => alignSelection('top') },
    { label: 'Align vertical centers', kbd: 'Alt+V', run: () => alignSelection('vcenter') },
    { label: 'Align bottom', kbd: 'Alt+S', run: () => alignSelection('bottom') },
    { label: 'Distribute horizontal spacing', run: () => distributeSelection('h') },
    { label: 'Distribute vertical spacing', run: () => distributeSelection('v') },
    { label: 'Text: Bold', kbd: 'Ctrl+B', run: () => toggleTextStyle('bold') },
    { label: 'Text: Italic', kbd: 'Ctrl+I', run: () => toggleTextStyle('italic') },
    { label: 'Text: Underline', kbd: 'Ctrl+U', run: () => toggleTextStyle('underline') },
    { label: 'Text: Strikethrough', run: () => toggleTextStyle('strike') },
    { label: 'Show / hide selection', kbd: 'Ctrl+Shift+H', run: () => update(sel(), (n) => ({ visible: n.visible === false ? undefined : false })) },
    { label: 'Lock / unlock selection', kbd: 'Ctrl+Shift+L', run: () => update(sel(), (n) => ({ locked: n.locked ? undefined : true })) },
    { label: 'Copy as SVG', run: () => void copyAs('svg') },
    { label: 'Copy as CSS', run: () => void copyAs('css') },
    { label: 'Copy as PNG', kbd: 'Ctrl+Shift+C', run: () => void copyAs('png') },
    { label: 'Export selection as PNG', run: () => exportNodes(sel(), 'PNG', 1) },
    { label: 'Export selection as SVG', run: () => exportNodes(sel(), 'SVG', 1) },
    { label: 'Zoom to fit', kbd: 'Shift+1', run: zoomToFit },
    { label: 'Zoom to selection', kbd: 'Shift+2', run: () => zoomToNodes(sel()) },
    { label: 'Zoom to 100%', kbd: 'Ctrl+0', run: () => zoomAt(1) },
    { label: 'Zoom in', kbd: '+', run: () => zoomAt(S().viewport.zoom * 1.5) },
    { label: 'Zoom out', kbd: '-', run: () => zoomAt(S().viewport.zoom / 1.5) },
    { label: 'Show / hide rulers', kbd: 'Shift+R', run: () => patchState({ showRulers: !S().showRulers }) },
    { label: 'Show / hide layout grids', kbd: 'Shift+G', run: () => patchState({ showGrids: !S().showGrids }) },
    { label: 'Show / hide comments', run: () => patchState({ showComments: !S().showComments }) },
    { label: 'Show / hide UI', kbd: 'Ctrl+\\', run: () => patchState({ uiHidden: !S().uiHidden }) },
    { label: 'Switch to Design tab', run: () => patchState({ mode: 'design' }) },
    { label: 'Switch to Prototype tab', kbd: 'Shift+E', run: () => patchState({ mode: 'prototype' }) },
    { label: 'Switch to Inspect tab', run: () => patchState({ mode: 'inspect' }) },
  ]
}

/** Quick actions (Ctrl+/): search and run any command. */
export function Palette({ commands }: { commands: Command[] }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const close = () => patchState({ paletteOpen: false })
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 60)
  }, [q, commands])
  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    // scrollIntoView may return a promise, which must not leak out as an effect cleanup.
    void list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [idx])
  const run = (c: Command | undefined) => {
    close()
    if (c) setTimeout(c.run, 0)
  }
  return (
    <>
      <div className="popover-backdrop dim" onPointerDown={close} />
      <div className="palette">
        <input
          autoFocus
          placeholder="Search actions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(shown.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') run(shown[idx])
          }}
        />
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <div className="hint pad">No matching actions</div>}
          {shown.map((c, i) => (
            <button key={c.label} className={'menu-item' + (i === idx ? ' active' : '')} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              <span className="grow">{c.label}</span>
              {c.kbd && <kbd>{c.kbd}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
