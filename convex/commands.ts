import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const latest = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) =>
    ctx.db
      .query('commands')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .order('desc')
      .first(),
})

export const send = mutation({
  args: { fileId: v.id('files'), type: v.string(), payload: v.any() },
  handler: async (ctx, { fileId, type, payload }) => {
    const old = await ctx.db
      .query('commands')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const c of old) await ctx.db.delete(c._id)
    return ctx.db.insert('commands', { fileId, type, payload })
  },
})
