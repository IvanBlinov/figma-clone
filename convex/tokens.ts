// Personal API tokens and OAuth-issued tokens for agents. The secret itself never reaches the database:
// the client generates it and sends only its SHA-256 hash.
import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { requireUser, tokenArg, viewerId } from './access'

export const list = query({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    const userId = await viewerId(ctx, token)
    if (!userId) return []
    const rows = await ctx.db
      .query('apiTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt).map((t) => ({ _id: t._id, name: t.name, prefix: t.prefix, kind: t.kind, createdAt: t.createdAt, expiresAt: t.expiresAt ?? null }))
  },
})

/** Register a personal API token. Only a browser session may create tokens (a token cannot mint more tokens). */
export const create = mutation({
  args: { name: v.string(), hash: v.string(), prefix: v.string(), expiresAt: v.optional(v.number()) },
  handler: async (ctx, { name, hash, prefix, expiresAt }) => {
    const userId = await requireUser(ctx)
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ConvexError('Invalid token hash')
    const existing = await ctx.db
      .query('apiTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    if (existing.length >= 50) throw new ConvexError('Too many tokens — revoke some first')
    return ctx.db.insert('apiTokens', { userId, name: name.trim().slice(0, 60) || 'API token', hash, prefix: prefix.slice(0, 12), kind: 'pat', createdAt: Date.now(), ...(expiresAt ? { expiresAt } : {}) })
  },
})

export const revoke = mutation({
  args: { tokenId: v.id('apiTokens'), ...tokenArg },
  handler: async (ctx, { tokenId, token }) => {
    const userId = await requireUser(ctx, token)
    const row = await ctx.db.get(tokenId)
    if (row && row.userId === userId) await ctx.db.delete(tokenId)
  },
})
