import { useMutation, useQuery } from 'convex/react'
import { Bot, Check, ChevronDown, Menu as MenuIcon, Play, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { AuthForm, ShareDialog } from '../Account'
import { applyOpsToList } from '../../shared/doc'
import type { Pt } from '../../shared/geometry'
import type { Op, PrototypeDevice, SceneNode } from '../../shared/types'
import {
  addAutoLayout,
  bindUploader,
  booleanOperation,
  combineAsVariants,
  copyAs,
  copySelection,
  createComponent,
  detachInstances,
  flattenSelection,
  goToMainComponent,
  toggleMask,
  topFrameOf,
  deleteSelection,
  duplicateSelection,
  pasteClip,
  reorderSelection,
  ungroupSelection,
  update,
  wrapSelection,
  zoomAt,
  zoomToFit,
  zoomToNodes,
} from './actions'
import { Canvas } from './Canvas'
import { makeThumbnail } from './export'
import { InspectPanel } from './InspectPanel'
import { LayersPanel } from './LayersPanel'
import { buildCommands, Palette } from './Palette'
import { PropertiesPanel } from './PropertiesPanel'
import { PrototypePanel } from './PrototypePanel'
import { installShortcuts } from './shortcuts'
import { bindRemote, clearHistory, patchState, resetEditor, S, select, setRaw, setTool, useEditor } from './store'
import { useStyles, type StyleDoc } from './stylesStore'
import { installVideoPosters } from './videoPoster'
import { Toolbar } from './Toolbar'
import { TextInput } from './ui'

const COLORS = ['#F24822', '#FFA629', '#14AE5C', '#0D99FF', '#9747FF', '#FF24BD', '#00B5CE', '#E06666']
const ANIMALS = ['Otter', 'Fox', 'Panda', 'Koala', 'Lynx', 'Heron', 'Badger', 'Finch', 'Gecko', 'Moose', 'Raven', 'Tapir']

function me(): { name: string; color: string } {
  try {
    const saved = JSON.parse(localStorage.getItem('figclone.user') ?? 'null')
    if (saved?.name && saved?.color) return saved
  } catch {
    /* fall through */
  }
  const user = {
    name: 'Anonymous ' + ANIMALS[Math.floor(Math.random() * ANIMALS.length)],
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }
  localStorage.setItem('figclone.user', JSON.stringify(user))
  return user
}

interface Menu {
  x: number
  y: number
  world: Pt
}

export function Editor({ fileId }: { fileId: Id<'files'> }) {
  // `file` is null when it does not exist or the viewer has no access; nothing else is requested until it loads.
  const file = useQuery(api.files.get, { fileId })
  const account = useQuery(api.users.me, {})
  const open = file ? { fileId } : 'skip'
  const pages = useQuery(api.pages.list, open)
  const [pageId, setPageId] = useState<Id<'pages'> | null>(null)
  const nodes = useQuery(api.nodes.list, file && pageId ? { pageId } : 'skip') as SceneNode[] | undefined
  const presence = useQuery(api.presence.list, open)
  const comments = useQuery(api.comments.list, open)
  const command = useQuery(api.commands.latest, open)
  const readOnly = file?.role === 'viewer'

  const applyOps = useMutation(api.nodes.applyOps).withOptimisticUpdate((store, args) => {
    const cur = store.getQuery(api.nodes.list, { pageId: args.pageId })
    if (cur) store.setQuery(api.nodes.list, { pageId: args.pageId }, applyOpsToList(cur as SceneNode[], args.ops as Op[]))
  })
  const renameFile = useMutation(api.files.rename)
  const setThumbnail = useMutation(api.files.setThumbnail)
  const createPage = useMutation(api.pages.create)
  const updatePage = useMutation(api.pages.update)
  const removePage = useMutation(api.pages.remove)
  const updatePresence = useMutation(api.presence.update)
  const leavePresence = useMutation(api.presence.leave)
  const genUpload = useMutation(api.images.generateUploadUrl)
  const getUrl = useMutation(api.images.getUrl)
  const addComment = useMutation(api.comments.add)
  const replyComment = useMutation(api.comments.reply)
  const resolveComment = useMutation(api.comments.setResolved)
  const removeComment = useMutation(api.comments.remove)
  const projects = useQuery(api.projects.list, {})
  const styles = useQuery(api.styles.list, open)
  const createStyle = useMutation(api.styles.create)
  const updateStyle = useMutation(api.styles.update)
  const removeStyle = useMutation(api.styles.remove)
  const saveVersion = useMutation(api.versions.save)

  const guest = useMemo(me, [])
  // Signed-in people appear under their own name; link visitors get a random guest name.
  const user = useMemo(
    () => (account ? { name: account.name, color: COLORS[[...account._id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length] } : guest),
    [account, guest],
  )
  const [shareOpen, setShareOpen] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)
  const sessionId = useMemo(() => Math.random().toString(36).slice(2) + Date.now().toString(36), [])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [zoomMenu, setZoomMenu] = useState(false)
  const [draftComment, setDraftComment] = useState<Pt | null>(null)
  const [openComment, setOpenComment] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [fileMenu, setFileMenu] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const mode = useEditor((s) => s.mode)
  const paletteOpen = useEditor((s) => s.paletteOpen)
  const vedit = useEditor((s) => !!s.vedit)
  const showRulers = useEditor((s) => s.showRulers)
  const showGrids = useEditor((s) => s.showGrids)
  const uiHidden = useEditor((s) => s.uiHidden)
  const zoom = useEditor((s) => s.viewport.zoom)
  const tool = useEditor((s) => s.tool)

  useEffect(() => {
    patchState({ readOnly, ...(readOnly ? { mode: 'inspect' as const, tool: 'move' as const } : S().mode === 'inspect' && S().readOnly ? { mode: 'design' as const } : {}) })
  }, [readOnly])
  useEffect(() => {
    if (account) setSignInOpen(false)
  }, [account])

  // ----- page selection -----
  useEffect(() => {
    if (!pages?.length) return
    if (!pageId || !pages.some((p) => p._id === pageId)) setPageId(pages[0]._id)
  }, [pages, pageId])

  const fitted = useRef<string | null>(null)
  useEffect(() => {
    resetEditor()
    setDraftComment(null)
    setOpenComment(null)
  }, [pageId, fileId])

  useEffect(() => {
    if (!pageId) return
    bindRemote((ops) => void applyOps({ fileId, pageId, ops }))
  }, [applyOps, fileId, pageId])

  useEffect(() => {
    if (!nodes || !pageId) return
    setRaw(pageId, nodes)
    if (fitted.current !== pageId) {
      fitted.current = pageId
      requestAnimationFrame(() => zoomToFit())
    }
  }, [nodes, pageId])

  const page = pages?.find((p) => p._id === pageId)
  useEffect(() => {
    patchState({ pageBg: page?.background ?? '#F5F5F5' })
  }, [page?.background])

  useEffect(() => installShortcuts(), [])
  useEffect(() => installVideoPosters(), [])
  useEffect(() => {
    bindUploader(async (blob) => {
      const url = await genUpload({})
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob })
      const { storageId } = await res.json()
      const served = await getUrl({ storageId })
      if (!served) throw new Error('Upload failed')
      return served
    })
  }, [genUpload, getUrl])

  useEffect(() => {
    document.title = file ? `${file.name} – Figma Clone` : 'Figma Clone'
  }, [file?.name])

  // ----- shared styles -----
  useEffect(() => {
    useStyles.setState({
      styles: (styles ?? []) as unknown as StyleDoc[],
      create: async (kind, name, value) => (await createStyle({ fileId, kind, name, value })) as string,
      update: (id, patch) => void updateStyle({ styleId: id as Id<'styles'>, ...patch }),
      remove: (id) => void removeStyle({ styleId: id as Id<'styles'> }),
    })
  }, [styles, fileId, createStyle, updateStyle, removeStyle])

  const say = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800)
  }, [])

  const present = useCallback(
    (frameId?: string) => {
      const st = S()
      let id = frameId
      if (!id && st.selection.length) {
        const top = topFrameOf(st.selection[0])
        if (st.doc.byId.get(top)?.type === 'FRAME') id = top
      }
      window.open(`${location.pathname}${location.search}#/proto/${fileId}/${pageId ?? ''}${id ? '/' + id : ''}`, '_blank')
    },
    [fileId, pageId],
  )

  const snapshot = useCallback(async () => {
    const label = prompt('Name this version', `Version ${new Date().toLocaleString()}`)
    if (label === null) return
    await saveVersion({ fileId, label, author: user.name })
    say('Version saved')
  }, [fileId, saveVersion, user.name, say])

  const commands = useMemo(
    () =>
      buildCommands([
        { label: 'Present prototype', run: () => present() },
        { label: 'Save version…', run: () => void snapshot() },
        { label: 'Version history…', run: () => setVersionsOpen(true) },
        { label: 'Back to files', run: () => (location.hash = '#/') },
      ]),
    [present, snapshot],
  )

  // ----- thumbnails -----
  useEffect(() => {
    let last: unknown = null
    const push = () => {
      const st = S()
      if (st.raw === last || !st.raw.length || !pages || pageId !== pages[0]?._id || st.readOnly) return
      last = st.raw
      const t = makeThumbnail()
      if (t) void setThumbnail({ fileId, thumbnail: t })
    }
    const iv = setInterval(push, 8000)
    return () => {
      clearInterval(iv)
      push()
    }
  }, [fileId, pageId, pages, setThumbnail])

  // ----- presence -----
  const cursor = useRef<Pt>({ x: 0, y: 0 })
  const dirty = useRef(true)
  useEffect(() => {
    let lastSent = 0
    const send = () => {
      const t = Date.now()
      if (!dirty.current && t - lastSent < 4000) return
      dirty.current = false
      lastSent = t
      void updatePresence({ fileId, sessionId, name: user.name, color: user.color, pageId: pageId ?? undefined, x: cursor.current.x, y: cursor.current.y, selection: S().selection })
    }
    const iv = setInterval(send, 90)
    const unsub = useEditor.subscribe((s, p) => {
      if (s.selection !== p.selection) dirty.current = true
    })
    const tick = setInterval(() => setNow(Date.now()), 4000)
    const bye = () => void leavePresence({ sessionId })
    window.addEventListener('beforeunload', bye)
    return () => {
      clearInterval(iv)
      clearInterval(tick)
      unsub()
      window.removeEventListener('beforeunload', bye)
      bye()
    }
  }, [fileId, pageId, sessionId, user, updatePresence, leavePresence])

  const others = useMemo(
    () => (presence ?? []).filter((p) => p.sessionId !== sessionId && now - p.updatedAt < (p.isAgent ? 90_000 : 15_000)),
    [presence, sessionId, now],
  )
  const remotes = useMemo(() => others.filter((o) => o.pageId === pageId).map((o) => ({ color: o.color, selection: o.selection })), [others, pageId])

  // ----- agent commands (MCP: select / focus) -----
  const mounted = useRef(Date.now())
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (!command || command._id === seen.current || command._creationTime < mounted.current - 2000) return
    seen.current = command._id
    const { pageId: target, nodeIds, zoom: doZoom } = (command.payload ?? {}) as { pageId?: Id<'pages'>; nodeIds?: string[]; zoom?: boolean }
    if (target && target !== pageId) setPageId(target)
    const run = (tries: number) => {
      const ids = (nodeIds ?? []).filter((id) => S().doc.byId.has(id))
      if (!ids.length && tries > 0 && nodeIds?.length) return setTimeout(() => run(tries - 1), 250)
      if (command.type === 'select') select(ids)
      if (doZoom !== false) ids.length ? zoomToNodes(ids) : zoomToFit()
    }
    setTimeout(() => run(8), 120)
  }, [command, pageId])

  const onCursor = useCallback((p: Pt) => {
    cursor.current = p
    dirty.current = true
  }, [])

  if (file === null)
    return account === null ? (
      <div className="auth-screen">
        <AuthForm note="Sign in to open this file. If it was shared with you, use the email address the invitation was sent to." />
      </div>
    ) : (
      <div className="center-msg">
        This file does not exist, or {account?.email ?? 'your account'} has not been given access to it. <a href="#/">Back to your files</a>
      </div>
    )
  const pageComments = (comments ?? []).filter((c) => c.pageId === pageId)

  return (
    <div className={'editor' + (uiHidden ? ' ui-hidden' : '')}>
      <aside className="left">
        <div className="file-head">
          <a href="#/" className="logo" title="Back to files">
            <Logo />
          </a>
          <div className="file-title">
            <TextInput className="file-name" value={file?.name ?? ''} onCommit={(name) => name.trim() && !readOnly && void renameFile({ fileId, name: name.trim() })} />
            <span className="sub">{projects?.find((p) => p._id === file?.projectId)?.name ?? 'Drafts'}</span>
          </div>
          <div className="file-menu-wrap">
            <button className="icon-btn" title="Main menu" onClick={() => setFileMenu((v) => !v)}>
              <MenuIcon size={15} />
            </button>
            {fileMenu && (
              <>
                <div className="popover-backdrop" onPointerDown={() => setFileMenu(false)} />
                <div className="menu file-menu" onClick={() => setFileMenu(false)}>
                  <MenuItem label="Back to files" onClick={() => (location.hash = '#/')} />
                  <MenuItem label="Quick actions…" kbd="Ctrl+/" onClick={() => patchState({ paletteOpen: true })} />
                  <hr />
                  <MenuItem label="Save version…" onClick={() => void snapshot()} />
                  <MenuItem label="Version history…" onClick={() => setVersionsOpen(true)} />
                  <hr />
                  <MenuItem label={(showRulers ? '✓ ' : '') + 'Rulers'} kbd="Shift+R" onClick={() => patchState({ showRulers: !showRulers })} />
                  <MenuItem label={(showGrids ? '✓ ' : '') + 'Layout grids'} kbd="Shift+G" onClick={() => patchState({ showGrids: !showGrids })} />
                  <MenuItem label="Show/hide comments" onClick={() => patchState({ showComments: !S().showComments })} />
                  <hr />
                  <MenuItem label="Present prototype" onClick={() => present()} />
                </div>
              </>
            )}
          </div>
        </div>
        <LayersPanel
          pages={pages ?? []}
          pageId={pageId}
          onSelectPage={(id) => setPageId(id as Id<'pages'>)}
          onAddPage={async () => !readOnly && setPageId(await createPage({ fileId }))}
          onRenamePage={(id, name) => !readOnly && void updatePage({ pageId: id as Id<'pages'>, name })}
          onDeletePage={(id) => !readOnly && void removePage({ pageId: id as Id<'pages'> })}
        />
      </aside>

      <main className="stage">
        <Canvas
          remotes={remotes}
          onCursor={onCursor}
          onCommentAt={(p) => {
            if (!account) {
              setTool('move')
              return setSignInOpen(true)
            }
            setOpenComment(null)
            setDraftComment(p)
          }}
          onContextMenu={(x, y, world) => setMenu({ x, y, world })}
        />
        <Overlays
          cursors={others.filter((o) => o.pageId === pageId)}
          comments={pageComments}
          draft={draftComment}
          open={openComment}
          setOpen={setOpenComment}
          onSubmit={(text) => {
            if (draftComment && pageId && text.trim()) void addComment({ fileId, pageId, x: draftComment.x, y: draftComment.y, author: user.name, color: user.color, text: text.trim() })
            setDraftComment(null)
            setTool('move')
          }}
          onReply={(id, text) => void replyComment({ commentId: id as Id<'comments'>, author: user.name, text })}
          onResolve={(id, resolved) => void resolveComment({ commentId: id as Id<'comments'>, resolved })}
          onDelete={(id) => void removeComment({ commentId: id as Id<'comments'> })}
        />
        <Toolbar />
        {tool === 'pen' && <div className="tool-hint">Click to add points, drag for curves. Click the first point to close, Enter to finish.</div>}
        {vedit && <div className="tool-hint">Drag points and handles · click a segment to add a point · double-click a point to toggle curve · Delete removes · Esc exits</div>}
        {toast && <div className="tool-hint toast">{toast}</div>}
      </main>

      <aside className="right">
        <div className="right-head">
          <div className="avatars">
            {others.slice(0, 4).map((o) => (
              <span key={o.sessionId} className="avatar" style={{ background: o.color }} title={o.name + (o.isAgent ? ' (agent)' : '')}>
                {o.isAgent ? <Bot size={13} /> : o.name.replace('Anonymous ', '')[0]}
              </span>
            ))}
            <span className="avatar self" style={{ background: user.color }} title={user.name + ' (you)'}>
              {user.name.replace('Anonymous ', '')[0]}
            </span>
          </div>
          <button className="icon-btn present" title="Present prototype" onClick={() => present()}>
            <Play size={15} />
          </button>
          {account ? (
            <button className="btn primary" onClick={() => setShareOpen(true)}>
              Share
            </button>
          ) : (
            <button className="btn primary" onClick={() => setSignInOpen(true)}>
              Sign in
            </button>
          )}
          <div className="zoom">
            <button className="zoom-btn" onClick={() => setZoomMenu((z) => !z)}>
              {Math.round(zoom * 100)}% <ChevronDown size={10} />
            </button>
            {zoomMenu && (
              <>
                <div className="popover-backdrop" onPointerDown={() => setZoomMenu(false)} />
                <div className="menu zoom-menu" onClick={() => setZoomMenu(false)}>
                  <MenuItem label="Zoom in" kbd="+" onClick={() => zoomAt(S().viewport.zoom * 1.5)} />
                  <MenuItem label="Zoom out" kbd="-" onClick={() => zoomAt(S().viewport.zoom / 1.5)} />
                  <MenuItem label="Zoom to fit" kbd="Shift+1" onClick={zoomToFit} />
                  <MenuItem label="Zoom to selection" kbd="Shift+2" onClick={() => zoomToNodes(S().selection)} />
                  <hr />
                  <MenuItem label="Zoom to 50%" onClick={() => zoomAt(0.5)} />
                  <MenuItem label="Zoom to 100%" kbd="Ctrl+0" onClick={() => zoomAt(1)} />
                  <MenuItem label="Zoom to 200%" onClick={() => zoomAt(2)} />
                  <hr />
                  <MenuItem label="Show/hide UI" kbd="Ctrl+\" onClick={() => patchState({ uiHidden: !S().uiHidden })} />
                </div>
              </>
            )}
          </div>
        </div>
        <div className="tabs">
          {(readOnly ? (['inspect'] as const) : (['design', 'prototype', 'inspect'] as const)).map((m) => (
            <span key={m} className={'tab' + (mode === m ? ' active' : '')} onClick={() => patchState({ mode: m, protoDrag: null })}>
              {m[0].toUpperCase() + m.slice(1)}
            </span>
          ))}
        </div>
        {mode === 'design' && <PropertiesPanel fileName={file?.name ?? 'export'} onPageBg={(background) => pageId && void updatePage({ pageId, background })} />}
        {mode === 'prototype' && (
          <PrototypePanel
            onPresent={present}
            device={(pages?.find((p) => p._id === pageId) as { prototypeDevice?: PrototypeDevice } | undefined)?.prototypeDevice ?? null}
            onDevice={readOnly || !pageId ? undefined : (prototypeDevice) => void updatePage({ pageId, prototypeDevice })}
          />
        )}
        {mode === 'inspect' && <InspectPanel />}
      </aside>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} say={say} />}
      {paletteOpen && <Palette commands={commands} />}
      {shareOpen && <ShareDialog fileId={fileId} onClose={() => setShareOpen(false)} />}
      {signInOpen && (
        <>
          <div className="popover-backdrop dim" onPointerDown={() => setSignInOpen(false)} />
          <div className="modal bare" onKeyDown={(e) => e.stopPropagation()}>
            <AuthForm note="Sign in to comment, or to edit if you were invited." />
          </div>
        </>
      )}
      {versionsOpen && <VersionsModal fileId={fileId} author={user.name} onClose={() => setVersionsOpen(false)} />}
    </div>
  )
}

export function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="6" fill="#0D99FF" />
      <path d="M7 7h10v3h-6.5v2.5H15v3h-4.5V19H7z" fill="#fff" />
    </svg>
  )
}

function MenuItem({ label, kbd, onClick, disabled, danger }: { label: string; kbd?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={'menu-item' + (danger ? ' danger' : '')} disabled={disabled} onClick={onClick}>
      <span className="grow">{label}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  )
}

function VersionsModal({ fileId, author, onClose }: { fileId: Id<'files'>; author: string; onClose: () => void }) {
  const versions = useQuery(api.versions.list, { fileId })
  const save = useMutation(api.versions.save)
  const restore = useMutation(api.versions.restore)
  const remove = useMutation(api.versions.remove)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <div className="popover-backdrop dim" onPointerDown={onClose} />
      <div className="modal" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">Version history</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault()
            await save({ fileId, label, author })
            setLabel('')
          }}
        >
          <input className="text-input grow" placeholder="Describe this version" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn primary">Save version</button>
        </form>
        <div className="version-list">
          {versions?.length === 0 && <div className="hint pad">No versions saved yet.</div>}
          {versions?.map((v) => (
            <div className="version" key={v._id}>
              <div className="grow">
                <b className="ellipsis">{v.label}</b>
                <span className="time">
                  {new Date(v.createdAt).toLocaleString()} · {v.author ?? 'Unknown'} · {v.nodeCount} layers
                </span>
              </div>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Restore "${v.label}"? The current state is saved as a version first.`)) return
                  setBusy(true)
                  try {
                    await restore({ versionId: v._id, author })
                    clearHistory()
                    onClose()
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Restore
              </button>
              <button className="icon-btn" title="Delete version" onClick={() => void remove({ versionId: v._id })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ContextMenu({ menu, onClose, say }: { menu: Menu; onClose: () => void; say: (msg: string) => void }) {
  const st = S()
  const has = st.selection.length > 0
  const nodes = st.selection.map((id) => st.doc.byId.get(id)!).filter(Boolean)
  const canUngroup = nodes.some((n) => n.type === 'GROUP' || n.type === 'FRAME')
  const isInstance = nodes.some((n) => n.componentId || n.sourceId)
  const comps = nodes.filter((n) => n.isComponent).length
  const copy = (kind: 'svg' | 'css' | 'png') => void copyAs(kind).then((ok) => say(ok ? `Copied as ${kind.toUpperCase()}` : 'Copy failed'))
  const allHidden = has && nodes.every((n) => n.visible === false)
  const allLocked = has && nodes.every((n) => n.locked)
  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <>
      <div className="popover-backdrop" onPointerDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div className="menu ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.max(8, Math.min(menu.y, window.innerHeight - 700)) }}>
        <MenuItem label="Copy" kbd="Ctrl+C" disabled={!has} onClick={act(() => void navigator.clipboard?.writeText(copySelection() ?? '').catch(() => {}))} />
        <MenuItem label="Paste here" kbd="Ctrl+V" onClick={act(() => pasteClip(null, menu.world))} />
        <MenuItem label="Duplicate" kbd="Ctrl+D" disabled={!has} onClick={act(duplicateSelection)} />
        <MenuItem label="Delete" kbd="Del" disabled={!has} onClick={act(deleteSelection)} />
        <hr />
        <MenuItem label="Bring to front" kbd="]" disabled={!has} onClick={act(() => reorderSelection('front'))} />
        <MenuItem label="Bring forward" kbd="Ctrl+]" disabled={!has} onClick={act(() => reorderSelection('forward'))} />
        <MenuItem label="Send backward" kbd="Ctrl+[" disabled={!has} onClick={act(() => reorderSelection('backward'))} />
        <MenuItem label="Send to back" kbd="[" disabled={!has} onClick={act(() => reorderSelection('back'))} />
        <hr />
        <MenuItem label="Group selection" kbd="Ctrl+G" disabled={!has} onClick={act(() => wrapSelection('GROUP'))} />
        <MenuItem label="Frame selection" kbd="Ctrl+Alt+G" disabled={!has} onClick={act(() => wrapSelection('FRAME'))} />
        <MenuItem label="Ungroup" kbd="Ctrl+Shift+G" disabled={!canUngroup} onClick={act(ungroupSelection)} />
        <MenuItem label="Add auto layout" kbd="Shift+A" disabled={!has} onClick={act(addAutoLayout)} />
        <hr />
        {isInstance ? (
          <>
            <MenuItem label="Go to main component" onClick={act(goToMainComponent)} />
            <MenuItem label="Detach instance" kbd="Ctrl+Alt+B" onClick={act(detachInstances)} />
          </>
        ) : (
          <MenuItem label="Create component" kbd="Ctrl+Alt+K" disabled={!has} onClick={act(createComponent)} />
        )}
        {comps > 0 && <MenuItem label="Combine as variants" onClick={act(combineAsVariants)} />}
        <hr />
        <MenuItem label="Union" disabled={!has} onClick={act(() => booleanOperation('UNION'))} />
        <MenuItem label="Subtract" disabled={!has} onClick={act(() => booleanOperation('SUBTRACT'))} />
        <MenuItem label="Intersect" disabled={!has} onClick={act(() => booleanOperation('INTERSECT'))} />
        <MenuItem label="Exclude" disabled={!has} onClick={act(() => booleanOperation('EXCLUDE'))} />
        <MenuItem label="Flatten" kbd="Ctrl+E" disabled={!has} onClick={act(flattenSelection)} />
        <MenuItem label={nodes.length === 1 && nodes[0].isMask ? 'Remove mask' : 'Use as mask'} kbd="Ctrl+Alt+M" disabled={!has} onClick={act(toggleMask)} />
        <hr />
        <MenuItem label="Copy as SVG" disabled={!has} onClick={act(() => copy('svg'))} />
        <MenuItem label="Copy as CSS" disabled={!has} onClick={act(() => copy('css'))} />
        <MenuItem label="Copy as PNG" kbd="Ctrl+Shift+C" disabled={!has} onClick={act(() => copy('png'))} />
        <hr />
        <MenuItem label={allHidden ? 'Show' : 'Hide'} kbd="Ctrl+Shift+H" disabled={!has} onClick={act(() => update(st.selection, { visible: allHidden ? undefined : false }))} />
        <MenuItem label={allLocked ? 'Unlock' : 'Lock'} kbd="Ctrl+Shift+L" disabled={!has} onClick={act(() => update(st.selection, { locked: allLocked ? undefined : true }))} />
      </div>
    </>
  )
}

interface CommentDoc {
  _id: string
  _creationTime: number
  x: number
  y: number
  author: string
  color?: string
  text: string
  resolved: boolean
  replies: { author: string; text: string; createdAt: number }[]
}

function Overlays(props: {
  cursors: { sessionId: string; name: string; color: string; x: number; y: number; isAgent?: boolean }[]
  comments: CommentDoc[]
  draft: Pt | null
  open: string | null
  setOpen: (id: string | null) => void
  onSubmit: (text: string) => void
  onReply: (id: string, text: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
}) {
  const vp = useEditor((s) => s.viewport)
  const showComments = useEditor((s) => s.showComments)
  const sc = (p: Pt) => ({ left: p.x * vp.zoom + vp.x, top: p.y * vp.zoom + vp.y })
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  useEffect(() => setText(''), [props.draft])
  return (
    <div className="overlays">
      {showComments &&
        props.comments
          .filter((c) => !c.resolved || props.open === c._id)
          .map((c) => (
            <div key={c._id} className={'pin' + (props.open === c._id ? ' open' : '')} style={sc(c)}>
              <button className="pin-dot" style={{ background: c.color ?? '#0D99FF' }} onClick={() => props.setOpen(props.open === c._id ? null : c._id)} title={c.text}>
                {c.author.replace('Anonymous ', '')[0]}
              </button>
              {props.open === c._id && (
                <div className="thread" onKeyDown={(e) => e.stopPropagation()}>
                  <div className="thread-head">
                    <span className="grow">Comment</span>
                    <button className="icon-btn" title={c.resolved ? 'Reopen' : 'Resolve'} onClick={() => props.onResolve(c._id, !c.resolved)}>
                      <Check size={14} color={c.resolved ? '#14AE5C' : undefined} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete comment"
                      onClick={() => {
                        props.onDelete(c._id)
                        props.setOpen(null)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="msg">
                    <b>{c.author}</b> <span className="time">{new Date(c._creationTime).toLocaleString()}</span>
                    <p>{c.text}</p>
                  </div>
                  {c.replies.map((r, i) => (
                    <div className="msg" key={i}>
                      <b>{r.author}</b> <span className="time">{new Date(r.createdAt).toLocaleString()}</span>
                      <p>{r.text}</p>
                    </div>
                  ))}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (reply.trim()) props.onReply(c._id, reply.trim())
                      setReply('')
                    }}
                  >
                    <input placeholder="Reply" value={reply} onChange={(e) => setReply(e.target.value)} />
                  </form>
                </div>
              )}
            </div>
          ))}
      {props.draft && (
        <div className="pin open" style={sc(props.draft)}>
          <span className="pin-dot" style={{ background: '#0D99FF' }} />
          <form
            className="thread"
            onKeyDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              props.onSubmit(text)
            }}
          >
            <input autoFocus placeholder="Add a comment" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => !text.trim() && props.onSubmit('')} />
          </form>
        </div>
      )}
      {props.cursors.map((c) => (
        <div key={c.sessionId} className="cursor" style={sc(c)}>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M1 1l5.2 13 2-5.4 5.4-2z" fill={c.color} stroke="#fff" strokeWidth="1" />
          </svg>
          <span style={{ background: c.color }}>
            {c.isAgent && <Bot size={11} />} {c.name}
          </span>
        </div>
      ))}
    </div>
  )
}
