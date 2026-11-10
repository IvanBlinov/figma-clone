import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { fileAccess, pageAccess, tokenArg } from './access'

export const list = query({
  args: { pageId: v.id('pages'), ...tokenArg },
  handler: async (ctx, { pageId, token }) => {
    await pageAccess(ctx, pageId, token, 'view')
    const rows = await ctx.db
      .query('nodes')
      .withIndex('by_page', (q) => q.eq('pageId', pageId))
      .collect()
    return rows.map((r) => r.data)
  },
})

export const get = query({
  args: { fileId: v.id('files'), ids: v.array(v.string()), ...tokenArg },
  handler: async (ctx, { fileId, ids, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    const out = []
    for (const nid of ids) {
      const row = await ctx.db
        .query('nodes')
        .withIndex('by_file_nid', (q) => q.eq('fileId', fileId).eq('nid', nid))
        .unique()
      if (row) out.push({ pageId: row.pageId, node: row.data })
    }
    return out
  },
})

/**
 * The single write path for scene nodes. ops:
 *   { op: 'create', node }            full node JSON (node.id required)
 *   { op: 'update', id, patch }       shallow merge; a null value removes the key
 *   { op: 'delete', id }
 */
export const applyOps = mutation({
  args: { fileId: v.id('files'), pageId: v.id('pages'), ops: v.array(v.any()), ...tokenArg },
  handler: async (ctx, { fileId, pageId, ops, token }) => {
    const { page } = await pageAccess(ctx, pageId, token, 'edit')
    if (page.fileId !== fileId) throw new ConvexError('That page belongs to a different file')
    const find = (nid: string) =>
      ctx.db
        .query('nodes')
        .withIndex('by_file_nid', (q) => q.eq('fileId', fileId).eq('nid', nid))
        .unique()
    for (const op of ops) {
      if (op.op === 'create') {
        const node = op.node
        if (!node || typeof node.id !== 'string') throw new ConvexError('create op needs node.id')
        const existing = await find(node.id)
        if (existing) await ctx.db.patch(existing._id, { data: node, pageId })
        else await ctx.db.insert('nodes', { fileId, pageId, nid: node.id, data: node })
      } else if (op.op === 'update') {
        const row = await find(op.id)
        if (!row) continue
        const data = { ...row.data }
        for (const [k, val] of Object.entries(op.patch ?? {})) {
          if (k === 'id') continue
          if (val === null) delete data[k]
          else data[k] = val
        }
        await ctx.db.patch(row._id, { data })
      } else if (op.op === 'delete') {
        const row = await find(op.id)
        if (row) await ctx.db.delete(row._id)
      }
    }
    await ctx.db.patch(fileId, { updatedAt: Date.now() })
  },
})
