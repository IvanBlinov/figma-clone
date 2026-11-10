import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { fileAccess, tokenArg } from './access'

export const latest = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    return ctx.db
      .query('commands')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .order('desc')
      .first()
  },
})

export const send = mutation({
  args: { fileId: v.id('files'), type: v.string(), payload: v.any(), ...tokenArg },
  handler: async (ctx, { fileId, type, payload, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    const old = await ctx.db
      .query('commands')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const c of old) await ctx.db.delete(c._id)
    return ctx.db.insert('commands', { fileId, type, payload })
  },
})
