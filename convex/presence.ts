import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { fileAccess, tokenArg, tryAccess } from './access'

export const list = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    return ctx.db
      .query('presence')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
  },
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
    ...tokenArg,
  },
  handler: async (ctx, { token, ...args }) => {
    // Anyone who can see the file shows up in it; silently ignore everybody else.
    if (!(await tryAccess(ctx, args.fileId, token))) return
    const now = Date.now()
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique()
    if (existing) {
      if (existing.fileId === args.fileId) await ctx.db.patch(existing._id, { ...args, updatedAt: now })
    } else {
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

/** Session ids are unguessable random strings known only to their own client. */
export const leave = mutation({
  args: { sessionId: v.string(), ...tokenArg },
  handler: async (ctx, { sessionId }) => {
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (existing) await ctx.db.delete(existing._id)
  },
})
