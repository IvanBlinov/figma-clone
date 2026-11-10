import { kids } from '../../shared/doc'
import {
  addAutoLayout,
  alignSelection,
  copyAs,
  copySelection,
  createComponent,
  detachInstances,
  flattenSelection,
  setOpacity,
  toggleMask,
  toggleTextStyle,
  deleteSelection,
  duplicateSelection,
  insertNode,
  makeNode,
  nudge,
  pasteClip,
  placeImage,
  placement,
  reorderSelection,
  selectAll,
  ungroupSelection,
  update,
  wrapSelection,
  zoomAt,
  zoomToFit,
  zoomToNodes,
} from './actions'
import { finishPen } from './Canvas'
import { patchState, redo, S, screenToWorld, select, setTool, undo, type Tool } from './store'
import { importSvg } from './svgImport'
import { finishTextEdit, focusProxy, startTextEdit } from './textEdit'
import { deleteVectorPoints, enterVectorEdit, exitVectorEdit, nudgeVectorPoints } from './vectorOps'

const TOOL_KEYS: Record<string, Tool> = {
  KeyV: 'move',
  KeyH: 'hand',
  KeyF: 'frame',
  KeyR: 'rectangle',
  KeyO: 'ellipse',
  KeyL: 'line',
  KeyP: 'pen',
  KeyT: 'text',
  KeyC: 'comment',
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e.target)) return
    const st = S()
    const mod = e.ctrlKey || e.metaKey
    const done = () => e.preventDefault()
    if (e.key === 'Alt') {
      if (!st.altDown) patchState({ altDown: true })
      return done()
    }
    if (st.editingId) {
      // Focus drifted to a panel control while editing text: Escape ends the edit, anything else returns to typing.
      if (e.key === 'Escape') finishTextEdit()
      else if (!mod) focusProxy()
      return
    }
    if (st.paletteOpen) return
    if (st.vedit && !mod) {
      const step = e.shiftKey ? 10 : 1
      switch (e.code) {
        case 'Escape':
        case 'Enter':
          return exitVectorEdit(), done()
        case 'Delete':
        case 'Backspace':
          return deleteVectorPoints(), done()
        case 'ArrowLeft':
          return nudgeVectorPoints(-step, 0), done()
        case 'ArrowRight':
          return nudgeVectorPoints(step, 0), done()
        case 'ArrowUp':
          return nudgeVectorPoints(0, -step), done()
        case 'ArrowDown':
          return nudgeVectorPoints(0, step), done()
      }
    }
    if (e.code === 'Space') {
      if (!st.spaceDown) patchState({ spaceDown: true })
      return done()
    }
    if (mod) {
      if (e.key === '/') return patchState({ paletteOpen: true }), done()
      switch (e.code) {
        case 'KeyZ':
          e.shiftKey ? redo() : undo()
          return done()
        case 'KeyY':
          redo()
          return done()
        case 'KeyD':
          duplicateSelection()
          return done()
        case 'KeyG':
          if (e.shiftKey) ungroupSelection()
          else if (e.altKey) wrapSelection('FRAME')
          else wrapSelection('GROUP')
          return done()
        case 'KeyA':
          selectAll()
          return done()
        case 'BracketRight':
          reorderSelection('forward')
          return done()
        case 'BracketLeft':
          reorderSelection('backward')
          return done()
        case 'Digit0':
          zoomAt(1)
          return done()
        case 'Equal':
        case 'NumpadAdd':
          zoomAt(st.viewport.zoom * 1.5)
          return done()
        case 'Minus':
        case 'NumpadSubtract':
          zoomAt(st.viewport.zoom / 1.5)
          return done()
        case 'Backslash':
          patchState({ uiHidden: !st.uiHidden })
          return done()
        case 'KeyH':
          if (e.shiftKey && st.selection.length) {
            update(st.selection, (n) => ({ visible: n.visible === false ? undefined : false }))
            return done()
          }
          return
        case 'KeyL':
          if (e.shiftKey && st.selection.length) {
            update(st.selection, (n) => ({ locked: n.locked ? undefined : true }))
            return done()
          }
          return
        case 'KeyK':
          if (e.altKey) return createComponent(), done()
          if (e.shiftKey) {
            document.getElementById('image-file-input')?.click()
            return done()
          }
          return
        case 'KeyB':
          if (e.altKey) detachInstances()
          else toggleTextStyle('bold')
          return done()
        case 'KeyI':
          if (e.shiftKey) return
          toggleTextStyle('italic')
          return done()
        case 'KeyU':
          toggleTextStyle('underline')
          return done()
        case 'KeyE':
          flattenSelection()
          return done()
        case 'KeyM':
          if (e.altKey) return toggleMask(), done()
          return
        case 'Slash':
        case 'KeyP':
          patchState({ paletteOpen: true })
          return done()
        case 'KeyF':
          if (st.uiHidden) patchState({ uiHidden: false })
          setTimeout(() => document.getElementById('layer-search')?.focus(), 0)
          return done()
        case 'KeyC':
          if (e.shiftKey) {
            void copyAs('png')
            return done()
          }
          return
      }
      return
    }
    if (e.altKey) {
      const map: Record<string, Parameters<typeof alignSelection>[0]> = { KeyA: 'left', KeyD: 'right', KeyW: 'top', KeyS: 'bottom', KeyH: 'hcenter', KeyV: 'vcenter' }
      if (map[e.code]) {
        alignSelection(map[e.code])
        return done()
      }
      return
    }
    if (e.shiftKey) {
      if (e.code === 'Digit1') return zoomToFit(), done()
      if (e.code === 'Digit2') return zoomToNodes(st.selection), done()
      if (e.code === 'KeyA') return addAutoLayout(), done()
      if (e.code === 'KeyG') return patchState({ showGrids: !st.showGrids }), done()
      if (e.code === 'KeyR') return patchState({ showRulers: !st.showRulers }), done()
      if (e.code === 'KeyP') return setTool('pencil'), done()
      if (e.code === 'KeyL') return setTool('arrow'), done()
      if (e.code === 'KeyE') return patchState({ mode: st.mode === 'prototype' ? 'design' : 'prototype' }), done()
    }
    if (!e.shiftKey && /^Digit\d$/.test(e.code) && st.selection.length) {
      const d = +e.code.slice(5)
      return setOpacity(d === 0 ? 1 : d / 10), done()
    }
    switch (e.code) {
      case 'Delete':
      case 'Backspace':
        if (st.pen) patchState({ pen: st.pen.points.length > 1 ? { ...st.pen, points: st.pen.points.slice(0, -1) } : null })
        else deleteSelection()
        return done()
      case 'Escape':
        if (st.pen) finishPen(false)
        else if (st.tool !== 'move') setTool('move')
        else select([])
        return done()
      case 'Enter': {
        if (st.pen) return finishPen(false), done()
        if (st.selection.length === 1) {
          const n = st.doc.byId.get(st.selection[0])
          if (n?.type === 'TEXT') startTextEdit(n.id)
          else if (n?.type === 'VECTOR') enterVectorEdit(n.id)
          else if (n) {
            const c = kids(st.doc, n.id)
            if (c.length) select(c)
          }
        }
        return done()
      }
      case 'ArrowLeft':
        return nudge(e.shiftKey ? -10 : -1, 0), done()
      case 'ArrowRight':
        return nudge(e.shiftKey ? 10 : 1, 0), done()
      case 'ArrowUp':
        return nudge(0, e.shiftKey ? -10 : -1), done()
      case 'ArrowDown':
        return nudge(0, e.shiftKey ? 10 : 1), done()
      case 'BracketRight':
        return reorderSelection('front'), done()
      case 'BracketLeft':
        return reorderSelection('back'), done()
      case 'Equal':
      case 'NumpadAdd':
        return zoomAt(st.viewport.zoom * 1.5), done()
      case 'Minus':
      case 'NumpadSubtract':
        return zoomAt(st.viewport.zoom / 1.5), done()
    }
    if (!e.shiftKey && TOOL_KEYS[e.code]) {
      setTool(TOOL_KEYS[e.code])
      done()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' && S().spaceDown) patchState({ spaceDown: false })
    if (e.key === 'Alt') {
      if (S().altDown) patchState({ altDown: false })
      e.preventDefault()
    }
  }
  const onCopy = (e: ClipboardEvent) => {
    if (typing(e.target)) return
    const json = copySelection()
    if (!json) return
    e.clipboardData?.setData('text/plain', json)
    e.preventDefault()
    if (e.type === 'cut') deleteSelection()
  }
  const onPaste = (e: ClipboardEvent) => {
    if (typing(e.target)) return
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      for (const f of files) void placeImage(f)
      return e.preventDefault()
    }
    const text = e.clipboardData?.getData('text/plain')
    e.preventDefault()
    if (pasteClip(text)) return
    if (text && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) && importSvg(text)) return
    if (text?.trim() && !text.trim().startsWith('{"figclone"')) {
      const st = S()
      const pl = placement(screenToWorld(st.canvasSize.w / 2, st.canvasSize.h / 2))
      insertNode(makeNode('TEXT', { parentId: pl.parentId, x: Math.round(pl.local.x), y: Math.round(pl.local.y), characters: text, name: text.split('\n')[0].slice(0, 40) }))
    }
  }
  const onBlur = () => (S().spaceDown || S().altDown) && patchState({ spaceDown: false, altDown: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCopy)
  document.addEventListener('paste', onPaste)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCopy)
    document.removeEventListener('paste', onPaste)
  }
}
