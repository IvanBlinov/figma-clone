import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { accessibleFiles, deleteFileMeta, fileAccess, fileMeta, requireUser, setFileThumbnail, tokenArg, touchFile, tryAccess, viewerId } from './access'

/** Files the caller owns or has been invited to, newest first. Signed-out callers get an empty list. */
export const list = query({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    const userId = await viewerId(ctx, token)
    if (!userId) return []
    const rows = await accessibleFiles(ctx, userId)
    const out = []
    for (const { file, role } of rows) {
      const owner = role === 'owner' || !file.ownerId ? null : await ctx.db.get(file.ownerId)
      out.push({ ...file, ...(await fileMeta(ctx, file)), role, ownerName: owner ? (owner.name ?? owner.email ?? 'Someone') : null })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },
})

/** A file with the caller's role, or null if it does not exist or the caller has no access. */
export const get = query({
  // A plain string, so a malformed id in a URL reads as 'not found' instead of an error.
  args: { fileId: v.string(), ...tokenArg },
  handler: async (ctx, { fileId: raw, token }) => {
    const fileId = ctx.db.normalizeId('files', raw)
    if (!fileId) return null
    const a = await tryAccess(ctx, fileId, token)
    if (!a) return null
    const project = a.file.projectId ? await ctx.db.get(a.file.projectId) : null
    // The preview is left out: the editor never shows it, and older files still carry it as a large base64 string.
    const { thumbnail: _legacy, ...file } = a.file
    return { ...file, role: a.role, signedIn: !!a.userId, projectName: project?.name ?? null }
  },
})

export const create = mutation({
  args: { name: v.optional(v.string()), projectId: v.optional(v.id('projects')), ...tokenArg },
  handler: async (ctx, { name, projectId, token }) => {
    const userId = await requireUser(ctx, token)
    if (projectId) {
      const project = await ctx.db.get(projectId)
      if (!project || project.ownerId !== userId) throw new ConvexError('Project not found')
    }
    const fileId = await ctx.db.insert('files', { name: name || 'Untitled', updatedAt: Date.now(), ownerId: userId, ...(projectId ? { projectId } : {}) })
    const pageId = await ctx.db.insert('pages', { fileId, name: 'Page 1', order: 0 })
    return { fileId, pageId }
  },
})

export const rename = mutation({
  args: { fileId: v.id('files'), name: v.string(), ...tokenArg },
  handler: async (ctx, { fileId, name, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    await ctx.db.patch(fileId, { name })
    await touchFile(ctx, fileId)
  },
})

/** Move a file into one of your projects, or back to drafts (projectId null). */
export const setProject = mutation({
  args: { fileId: v.id('files'), projectId: v.union(v.id('projects'), v.null()), ...tokenArg },
  handler: async (ctx, { fileId, projectId, token }) => {
    const { userId } = await fileAccess(ctx, fileId, token, 'owner')
    if (projectId) {
      const project = await ctx.db.get(projectId)
      if (!project || project.ownerId !== userId) throw new ConvexError('Project not found')
    }
    await ctx.db.patch(fileId, { projectId: projectId ?? undefined })
  },
})

export const setThumbnail = mutation({
  args: { fileId: v.id('files'), storageId: v.id('_storage'), ...tokenArg },
  handler: async (ctx, { fileId, storageId, token }) => {
    const a = await tryAccess(ctx, fileId, token)
    if (a && a.role !== 'viewer') await setFileThumbnail(ctx, a.file, storageId)
    else await ctx.storage.delete(storageId)
  },
})

export const remove = mutation({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'owner')
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const p of pages) {
      const nodes = await ctx.db
        .query('nodes')
        .withIndex('by_page', (q) => q.eq('pageId', p._id))
        .collect()
      for (const n of nodes) await ctx.db.delete(n._id)
      await ctx.db.delete(p._id)
    }
    const versions = await ctx.db
      .query('versions')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const ver of versions) {
      const rows = await ctx.db
        .query('versionNodes')
        .withIndex('by_version', (q) => q.eq('versionId', ver._id))
        .collect()
      for (const r of rows) await ctx.db.delete(r._id)
      await ctx.db.delete(ver._id)
    }
    for (const table of ['presence', 'comments', 'commands', 'styles', 'codeConnect'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_file', (q) => q.eq('fileId', fileId))
        .collect()
      for (const r of rows) await ctx.db.delete(r._id)
    }
    const shares = await ctx.db
      .query('shares')
      .withIndex('by_file_email', (q) => q.eq('fileId', fileId))
      .collect()
    for (const s of shares) await ctx.db.delete(s._id)
    await deleteFileMeta(ctx, fileId)
    await ctx.db.delete(fileId)
  },
})

/** Copy a file you can view into your own drafts (or next to the original if you own it). */
export const duplicate = mutation({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    const userId = await requireUser(ctx, token)
    const { file, role } = await fileAccess(ctx, fileId, token, 'view')
    const newId = await ctx.db.insert('files', {
      name: file.name + ' (Copy)',
      updatedAt: Date.now(),
      ownerId: userId,
      ...(role === 'owner' && file.projectId ? { projectId: file.projectId } : {}),
    })
    // The copy shows the original's preview until it is opened and renders its own.
    const { thumbnail } = await fileMeta(ctx, file)
    await ctx.db.insert('fileMeta', { fileId: newId, updatedAt: Date.now(), ...(thumbnail && !thumbnail.startsWith('data:') ? { thumbnail } : {}) })
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const p of pages) {
      const pid = await ctx.db.insert('pages', { fileId: newId, name: p.name, order: p.order, background: p.background, prototypeDevice: p.prototypeDevice })
      const nodes = await ctx.db
        .query('nodes')
        .withIndex('by_page', (q) => q.eq('pageId', p._id))
        .collect()
      for (const n of nodes) await ctx.db.insert('nodes', { fileId: newId, pageId: pid, nid: n.nid, data: n.data })
    }
    return newId
  },
})

/**
 * One-off migration for data created before accounts existed: gives every file and project that has no owner
 * to the user with this email. Internal, so it can only be run by a deployment admin:
 *   npx convex run --prod files:adoptOrphans '{"email":"you@example.com"}'
 */
export const adoptOrphans = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', email.trim().toLowerCase()))
      .first()
    if (!user) throw new ConvexError(`No account with the email ${email}. Sign up in the app first.`)
    let files = 0
    let projects = 0
    for (const f of await ctx.db.query('files').collect())
      if (!f.ownerId) {
        await ctx.db.patch(f._id, { ownerId: user._id })
        files++
      }
    for (const p of await ctx.db.query('projects').collect())
      if (!p.ownerId) {
        await ctx.db.patch(p._id, { ownerId: user._id })
        projects++
      }
    return { files, projects }
  },
})

/**
 * One-off migration: previews used to be base64 strings on the files row, which made every read of a file cost
 * up to 400 KB. This moves them into file storage. Run once after deploying:
 *   npx convex run --prod files:migrateThumbnails
 */
export const migrateThumbnails = internalAction({
  args: {},
  handler: async (ctx): Promise<{ moved: number }> => {
    let cursor: string | null = null
    let moved = 0
    for (;;) {
      const page: { rows: { fileId: Id<'files'>; thumbnail: string }[]; cursor: string; done: boolean } = await ctx.runQuery(internal.files.legacyThumbnails, { cursor })
      for (const { fileId, thumbnail } of page.rows) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(thumbnail)
        let storageId: Id<'_storage'> | undefined
        if (m) {
          const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
          storageId = await ctx.storage.store(new Blob([bytes], { type: m[1] }))
        }
        await ctx.runMutation(internal.files.finishThumbnailMigration, { fileId, storageId })
        moved++
      }
      if (page.done) return { moved }
      cursor = page.cursor
    }
  },
})

export const legacyThumbnails = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const res = await ctx.db.query('files').paginate({ cursor, numItems: 8 })
    return {
      rows: res.page.filter((f) => f.thumbnail !== undefined).map((f) => ({ fileId: f._id, thumbnail: f.thumbnail! })),
      cursor: res.continueCursor,
      done: res.isDone,
    }
  },
})

export const finishThumbnailMigration = internalMutation({
  args: { fileId: v.id('files'), storageId: v.optional(v.id('_storage')) },
  handler: async (ctx, { fileId, storageId }) => {
    const file = await ctx.db.get(fileId)
    if (!file) {
      if (storageId) await ctx.storage.delete(storageId)
      return
    }
    // A preview rendered since the deploy is newer than the legacy one: keep it.
    const current = (await fileMeta(ctx, file)).thumbnail
    if (storageId && (!current || current.startsWith('data:'))) await setFileThumbnail(ctx, file, storageId)
    else if (storageId) await ctx.storage.delete(storageId)
    if ((await ctx.db.get(fileId))?.thumbnail !== undefined) await ctx.db.patch(fileId, { thumbnail: undefined })
  },
})
