import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { requireUser, tokenArg, viewerId } from './access'

/** The signed-in user (or the user an access token belongs to); null when signed out. */
export const me = query({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    const id = await viewerId(ctx, token)
    const user = id ? await ctx.db.get(id) : null
    return user ? { _id: user._id, name: user.name ?? user.email?.split('@')[0] ?? 'User', email: user.email ?? '' } : null
  },
})

export const rename = mutation({
  args: { name: v.string(), ...tokenArg },
  handler: async (ctx, { name, token }) => {
    const id = await requireUser(ctx, token)
    if (name.trim()) await ctx.db.patch(id, { name: name.trim().slice(0, 80) })
  },
})
