import { useMutation, useQuery } from 'convex/react'
import { ChevronRight, Clock, Copy, FileText, Folder, FolderInput, FolderPlus, LayoutGrid, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { Logo } from './editor/Editor'

function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  return `${Math.round(s / 86400)} days ago`
}

type View = { kind: 'recents' } | { kind: 'drafts' } | { kind: 'projects' } | { kind: 'project'; id: Id<'projects'> }

/** The view lives in the URL (#/, #/drafts, #/projects, #/project/<id>) so Back works and links can be shared. */
function viewFromHash(hash: string): View {
  const m = hash.match(/^#\/project\/([\w-]+)/)
  if (m) return { kind: 'project', id: m[1] as Id<'projects'> }
  if (hash.startsWith('#/drafts')) return { kind: 'drafts' }
  if (hash.startsWith('#/projects')) return { kind: 'projects' }
  return { kind: 'recents' }
}

type Menu = { x: number; y: number } & ({ file: Id<'files'>; moving?: boolean } | { project: Id<'projects'> })

export function Home() {
  const files = useQuery(api.files.list)
  const projects = useQuery(api.projects.list)
  const create = useMutation(api.files.create)
  const rename = useMutation(api.files.rename)
  const remove = useMutation(api.files.remove)
  const duplicate = useMutation(api.files.duplicate)
  const setProject = useMutation(api.files.setProject)
  const createProject = useMutation(api.projects.create)
  const renameProject = useMutation(api.projects.rename)
  const removeProject = useMutation(api.projects.remove)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const view = viewFromHash(location.hash)

  const project = view.kind === 'project' ? projects?.find((p) => p._id === view.id) : undefined
  const title = view.kind === 'recents' ? 'Recents' : view.kind === 'drafts' ? 'Drafts' : view.kind === 'projects' ? 'All projects' : (project?.name ?? 'Project')
  useEffect(() => {
    document.title = `${title} – Figma Clone`
  }, [title])

  const newFile = async () => {
    const { fileId } = await create(view.kind === 'project' ? { projectId: view.id } : {})
    location.hash = `#/file/${fileId}`
  }
  const newProject = async () => {
    const id = await createProject({})
    location.hash = `#/project/${id}`
    setRenaming(id)
  }

  const q = query.trim().toLowerCase()
  const shown = (files ?? []).filter((f) => {
    if (q && !f.name.toLowerCase().includes(q)) return false
    if (view.kind === 'drafts') return !f.projectId
    if (view.kind === 'project') return f.projectId === view.id
    return true
  })
  const shownProjects = (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q))
  const projectName = (id: Id<'projects'> | undefined) => (id ? (projects?.find((p) => p._id === id)?.name ?? 'Project') : 'Drafts')
  const menuFile = menu && 'file' in menu ? files?.find((f) => f._id === menu.file) : undefined

  const nameInput = (id: string, value: string, onName: (name: string) => void) => (
    <input
      autoFocus
      defaultValue={value}
      onClick={(e) => e.preventDefault()}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        setRenaming(null)
        const name = e.target.value.trim()
        if (name && name !== value) onName(name)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setRenaming(null)
      }}
      key={id}
    />
  )

  return (
    <div className="home">
      <aside className="home-side">
        <div className="home-brand">
          <Logo /> <b>Figma Clone</b>
        </div>
        <div className="home-search">
          <Search size={14} />
          <input placeholder={view.kind === 'projects' ? 'Search projects' : 'Search files'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <nav>
          <a href="#/" className={view.kind === 'recents' ? 'active' : ''}>
            <Clock size={15} /> Recents
          </a>
          <a href="#/drafts" className={view.kind === 'drafts' ? 'active' : ''}>
            <FileText size={15} /> <span className="grow">Drafts</span>
            <span className="count">{files?.filter((f) => !f.projectId).length ?? ''}</span>
          </a>
          <a href="#/projects" className={view.kind === 'projects' ? 'active' : ''}>
            <LayoutGrid size={15} /> <span className="grow">All projects</span>
            <span className="count">{projects?.length ?? ''}</span>
          </a>
        </nav>
        <div className="home-projects">
          <div className="home-projects-head">
            <span>Projects</span>
            <button className="icon-btn" title="New project" onClick={() => void newProject()}>
              <Plus size={14} />
            </button>
          </div>
          <nav>
            {projects?.map((p) => (
              <a
                key={p._id}
                href={`#/project/${p._id}`}
                className={view.kind === 'project' && view.id === p._id ? 'active' : ''}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ project: p._id, x: e.clientX, y: e.clientY })
                }}
              >
                <Folder size={15} /> <span className="grow ellipsis">{p.name}</span>
                <span className="count">{p.fileCount}</span>
              </a>
            ))}
            {projects?.length === 0 && <span className="home-hint">No projects yet</span>}
          </nav>
        </div>
        <div className="home-note">
          Agents can drive this workspace through the <code>figma-clone</code> MCP server — see README.
        </div>
      </aside>
      <main className="home-main">
        <header>
          <h1>
            {view.kind === 'project' && (
              <>
                <a href="#/projects">All projects</a>
                <ChevronRight size={14} />
              </>
            )}
            {view.kind === 'project' && renaming === view.id && project ? (
              nameInput(view.id, project.name, (name) => void renameProject({ projectId: view.id, name }))
            ) : (
              <span onDoubleClick={() => view.kind === 'project' && setRenaming(view.id)}>{title}</span>
            )}
          </h1>
          <div className="home-actions">
            {view.kind === 'project' && project && (
              <>
                <button className="btn" onClick={() => setRenaming(view.id)}>
                  <Pencil size={13} /> Rename
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    if (!confirm(`Delete project "${project.name}"? Its ${project.fileCount} file(s) are kept and move to Drafts.`)) return
                    void removeProject({ projectId: view.id })
                    location.hash = '#/projects'
                  }}
                >
                  <Trash2 size={13} /> Delete project
                </button>
              </>
            )}
            {view.kind === 'projects' ? (
              <button className="btn primary" onClick={() => void newProject()}>
                <FolderPlus size={14} /> New project
              </button>
            ) : (
              <button className="btn primary" onClick={newFile}>
                <Plus size={14} /> New design file
              </button>
            )}
          </div>
        </header>

        {view.kind === 'project' && projects && !project ? (
          <p className="home-empty">
            This project does not exist. <a href="#/projects">Back to all projects</a>
          </p>
        ) : view.kind === 'projects' ? (
          <>
            <div className="file-grid">
              <button className="file-card new" onClick={() => void newProject()}>
                <div className="thumb">
                  <FolderPlus size={28} />
                </div>
                <div className="meta">
                  <b>New project</b>
                  <span>Group related files</span>
                </div>
              </button>
              <a className="file-card" href="#/drafts">
                <div className="thumb drafts">
                  <FileText size={28} />
                </div>
                <div className="meta">
                  <b>Drafts</b>
                  <span>{files?.filter((f) => !f.projectId).length ?? 0} files not in a project</span>
                </div>
              </a>
              {shownProjects.map((p) => (
                <a
                  key={p._id}
                  className="file-card"
                  href={`#/project/${p._id}`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ project: p._id, x: e.clientX, y: e.clientY })
                  }}
                >
                  <div className="thumb quad">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} style={p.thumbnails[i] ? { backgroundImage: `url(${p.thumbnails[i]})` } : undefined} />
                    ))}
                  </div>
                  <div className="meta">
                    {renaming === p._id ? nameInput(p._id, p.name, (name) => void renameProject({ projectId: p._id, name })) : <b>{p.name}</b>}
                    <span>
                      {p.fileCount} file{p.fileCount === 1 ? '' : 's'}
                      {p.fileCount ? ` · edited ${ago(p.updatedAt)}` : ''}
                    </span>
                  </div>
                </a>
              ))}
            </div>
            {projects && !shownProjects.length && q && <p className="home-empty">No projects match your search.</p>}
          </>
        ) : (
          <>
            <div className="file-grid">
              <button className="file-card new" onClick={newFile}>
                <div className="thumb">
                  <Plus size={28} />
                </div>
                <div className="meta">
                  <b>New design file</b>
                  <span>{view.kind === 'project' ? `In ${title}` : 'Start from a blank canvas'}</span>
                </div>
              </button>
              {shown.map((f) => (
                <a
                  key={f._id}
                  className="file-card"
                  href={`#/file/${f._id}`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ file: f._id, x: e.clientX, y: e.clientY })
                  }}
                >
                  <div className="thumb" style={f.thumbnail ? { backgroundImage: `url(${f.thumbnail})` } : undefined} />
                  <div className="meta">
                    {renaming === f._id ? nameInput(f._id, f.name, (name) => void rename({ fileId: f._id, name })) : <b>{f.name}</b>}
                    <span>
                      {view.kind === 'recents' ? `${projectName(f.projectId)} · ` : ''}Edited {ago(f.updatedAt)}
                    </span>
                  </div>
                </a>
              ))}
            </div>
            {files && !shown.length && (
              <p className="home-empty">
                {q
                  ? 'No files match your search.'
                  : view.kind === 'drafts'
                    ? 'No drafts — every file is in a project.'
                    : view.kind === 'project'
                      ? 'This project is empty. Create a file here, or right-click a file elsewhere and choose "Move to project".'
                      : 'No files yet — create your first design file.'}
              </p>
            )}
          </>
        )}
      </main>
      {menu && (
        <>
          <div className="popover-backdrop" onPointerDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 260) }}>
            {'project' in menu ? (
              <div onClick={() => setMenu(null)}>
                <button className="menu-item" onClick={() => (location.hash = `#/project/${menu.project}`)}>
                  <Folder size={14} /> <span className="grow">Open</span>
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    if (view.kind !== 'projects') location.hash = `#/project/${menu.project}`
                    setRenaming(menu.project)
                  }}
                >
                  <Pencil size={14} /> <span className="grow">Rename</span>
                </button>
                <hr />
                <button
                  className="menu-item danger"
                  onClick={() => {
                    const p = projects?.find((x) => x._id === menu.project)
                    if (!confirm(`Delete project "${p?.name}"? Its files are kept and move to Drafts.`)) return
                    void removeProject({ projectId: menu.project })
                    if (view.kind === 'project' && view.id === menu.project) location.hash = '#/projects'
                  }}
                >
                  <Trash2 size={14} /> <span className="grow">Delete project</span>
                </button>
              </div>
            ) : menu.moving ? (
              <div onClick={() => setMenu(null)}>
                <div className="menu-title">Move “{menuFile?.name}” to</div>
                <button className="menu-item" disabled={!menuFile?.projectId} onClick={() => void setProject({ fileId: menu.file, projectId: null })}>
                  <FileText size={14} /> <span className="grow">Drafts</span>
                </button>
                {projects?.map((p) => (
                  <button key={p._id} className="menu-item" disabled={menuFile?.projectId === p._id} onClick={() => void setProject({ fileId: menu.file, projectId: p._id })}>
                    <Folder size={14} /> <span className="grow ellipsis">{p.name}</span>
                  </button>
                ))}
                <hr />
                <button
                  className="menu-item"
                  onClick={async () => {
                    const name = prompt('Name of the new project')
                    if (!name?.trim()) return
                    const id = await createProject({ name })
                    await setProject({ fileId: menu.file, projectId: id })
                  }}
                >
                  <FolderPlus size={14} /> <span className="grow">New project…</span>
                </button>
              </div>
            ) : (
              <>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    location.hash = `#/file/${menu.file}`
                  }}
                >
                  <FileText size={14} /> <span className="grow">Open</span>
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    setRenaming(menu.file)
                  }}
                >
                  <Pencil size={14} /> <span className="grow">Rename</span>
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    void duplicate({ fileId: menu.file })
                  }}
                >
                  <Copy size={14} /> <span className="grow">Duplicate</span>
                </button>
                <button className="menu-item" onClick={() => setMenu({ ...menu, moving: true })}>
                  <FolderInput size={14} /> <span className="grow">Move to project</span>
                  <ChevronRight size={12} />
                </button>
                <hr />
                <button
                  className="menu-item danger"
                  onClick={() => {
                    setMenu(null)
                    if (confirm(`Delete "${menuFile?.name}"? This cannot be undone.`)) void remove({ fileId: menu.file })
                  }}
                >
                  <Trash2 size={14} /> <span className="grow">Delete</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
