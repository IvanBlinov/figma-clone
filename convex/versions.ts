import { mutation, query, type MutationCtx } from './_generated/server'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { fileAccess, tokenArg, touchFile } from './access'

export const list = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    const rows = await ctx.db
      .query('versions')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt)
  },
})

async function snapshot(ctx: MutationCtx, fileId: Id<'files'>, label: string, author?: string) {
  const pages = await ctx.db
    .query('pages')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect()
  const versionId = await ctx.db.insert('versions', {
    fileId,
    label,
    author,
    createdAt: Date.now(),
    nodeCount: 0,
    pages: pages.map((p) => ({ pageId: p._id as string, name: p.name, order: p.order, background: p.background, prototypeDevice: p.prototypeDevice })),
  })
  let count = 0
  for (const p of pages) {
    const nodes = await ctx.db
      .query('nodes')
      .withIndex('by_page', (q) => q.eq('pageId', p._id))
      .collect()
    for (const n of nodes) {
      await ctx.db.insert('versionNodes', { versionId, pageId: p._id as string, nid: n.nid, data: n.data })
      count++
    }
  }
  await ctx.db.patch(versionId, { nodeCount: count })
  return versionId
}

export const save = mutation({
  args: { fileId: v.id('files'), label: v.optional(v.string()), author: v.optional(v.string()), ...tokenArg },
  handler: async (ctx, { fileId, label, author, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    return snapshot(ctx, fileId, label?.trim() || 'Untitled version', author)
  },
})

/** Replace the file's pages and layers with a saved version. The current state is saved first so it can be brought back. */
export const restore = mutation({
  args: { versionId: v.id('versions'), author: v.optional(v.string()), ...tokenArg },
  handler: async (ctx, { versionId, author, token }) => {
    const version = await ctx.db.get(versionId)
    if (!version) throw new Error('Version not found')
    const fileId = version.fileId
    await fileAccess(ctx, fileId, token, 'edit')
    await snapshot(ctx, fileId, `Before restoring "${version.label}"`, author)
    const current = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    const clear = async (pageId: Id<'pages'>) => {
      const nodes = await ctx.db
        .query('nodes')
        .withIndex('by_page', (q) => q.eq('pageId', pageId))
        .collect()
      for (const n of nodes) await ctx.db.delete(n._id)
    }
    const pageMap = new Map<string, Id<'pages'>>()
    for (const sp of version.pages) {
      const existing = current.find((p) => p._id === sp.pageId)
      if (existing) {
        await clear(existing._id)
        await ctx.db.patch(existing._id, { name: sp.name, order: sp.order, background: sp.background, prototypeDevice: sp.prototypeDevice })
        pageMap.set(sp.pageId, existing._id)
      } else pageMap.set(sp.pageId, await ctx.db.insert('pages', { fileId, name: sp.name, order: sp.order, background: sp.background, prototypeDevice: sp.prototypeDevice }))
    }
    for (const p of current) {
      if (version.pages.some((sp) => sp.pageId === p._id)) continue
      await clear(p._id)
      await ctx.db.delete(p._id)
    }
    const nodes = await ctx.db
      .query('versionNodes')
      .withIndex('by_version', (q) => q.eq('versionId', versionId))
      .collect()
    for (const n of nodes) {
      const pageId = pageMap.get(n.pageId)
      if (pageId) await ctx.db.insert('nodes', { fileId, pageId, nid: n.nid, data: n.data })
    }
    await touchFile(ctx, fileId)
  },
})

export const remove = mutation({
  args: { versionId: v.id('versions'), ...tokenArg },
  handler: async (ctx, { versionId, token }) => {
    const version = await ctx.db.get(versionId)
    if (!version) return
    await fileAccess(ctx, version.fileId, token, 'edit')
    const nodes = await ctx.db
      .query('versionNodes')
      .withIndex('by_version', (q) => q.eq('versionId', versionId))
      .collect()
    for (const n of nodes) await ctx.db.delete(n._id)
    await ctx.db.delete(versionId)
  },
})
