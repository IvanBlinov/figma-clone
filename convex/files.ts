import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const list = query({
  args: {},
  handler: async (ctx) => {
    const files = await ctx.db.query('files').collect()
    return files.sort((a, b) => b.updatedAt - a.updatedAt)
  },
})

export const get = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => ctx.db.get(fileId),
})

export const create = mutation({
  args: { name: v.optional(v.string()), projectId: v.optional(v.id('projects')) },
  handler: async (ctx, { name, projectId }) => {
    if (projectId && !(await ctx.db.get(projectId))) throw new Error('Project not found')
    const fileId = await ctx.db.insert('files', { name: name || 'Untitled', updatedAt: Date.now(), ...(projectId ? { projectId } : {}) })
    const pageId = await ctx.db.insert('pages', { fileId, name: 'Page 1', order: 0 })
    return { fileId, pageId }
  },
})

export const rename = mutation({
  args: { fileId: v.id('files'), name: v.string() },
  handler: async (ctx, { fileId, name }) => {
    await ctx.db.patch(fileId, { name, updatedAt: Date.now() })
  },
})

/** Move a file into a project, or back to drafts (projectId null). */
export const setProject = mutation({
  args: { fileId: v.id('files'), projectId: v.union(v.id('projects'), v.null()) },
  handler: async (ctx, { fileId, projectId }) => {
    if (!(await ctx.db.get(fileId))) throw new Error('File not found')
    if (projectId && !(await ctx.db.get(projectId))) throw new Error('Project not found')
    await ctx.db.patch(fileId, { projectId: projectId ?? undefined })
  },
})

export const setThumbnail = mutation({
  args: { fileId: v.id('files'), thumbnail: v.string() },
  handler: async (ctx, { fileId, thumbnail }) => {
    if (thumbnail.length > 400_000) return
    const file = await ctx.db.get(fileId)
    if (file) await ctx.db.patch(fileId, { thumbnail })
  },
})

export const remove = mutation({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
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
    await ctx.db.delete(fileId)
  },
})

export const duplicate = mutation({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId)
    if (!file) throw new Error('File not found')
    const newId = await ctx.db.insert('files', {
      name: file.name + ' (Copy)',
      updatedAt: Date.now(),
      thumbnail: file.thumbnail,
      ...(file.projectId ? { projectId: file.projectId } : {}),
    })
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const p of pages) {
      const pid = await ctx.db.insert('pages', {
        fileId: newId,
        name: p.name,
        order: p.order,
        background: p.background,
      })
      const nodes = await ctx.db
        .query('nodes')
        .withIndex('by_page', (q) => q.eq('pageId', p._id))
        .collect()
      for (const n of nodes) await ctx.db.insert('nodes', { fileId: newId, pageId: pid, nid: n.nid, data: n.data })
    }
    return newId
  },
})
