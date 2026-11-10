import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const list = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) =>
    ctx.db
      .query('presence')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect(),
})

export const update = mutation({
  args: {
    fileId: v.id('files'),
    sessionId: v.string(),
    name: v.string(),
    color: v.string(),
    pageId: v.optional(v.string()),
    x: v.number(),
    y: v.number(),
    selection: v.array(v.string()),
    isAgent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique()
    if (existing) await ctx.db.patch(existing._id, { ...args, updatedAt: now })
    else {
      await ctx.db.insert('presence', { ...args, updatedAt: now })
      // Sweep stale rows whenever somebody joins.
      const rows = await ctx.db
        .query('presence')
        .withIndex('by_file', (q) => q.eq('fileId', args.fileId))
        .collect()
      for (const r of rows) if (now - r.updatedAt > 120_000) await ctx.db.delete(r._id)
    }
  },
})

export const leave = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (existing) await ctx.db.delete(existing._id)
  },
})
