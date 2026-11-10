// Sharing a file with other people (by email) and by link.
import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { fileAccess, tokenArg, tryAccess } from './access'

const role = v.union(v.literal('editor'), v.literal('viewer'))

/** Who has access to a file. Visible to everyone who can open it; only the owner can change it. */
export const get = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    const a = await tryAccess(ctx, fileId, token)
    if (!a) return null
    const owner = a.file.ownerId ? await ctx.db.get(a.file.ownerId) : null
    const shares = await ctx.db
      .query('shares')
      .withIndex('by_file_email', (q) => q.eq('fileId', fileId))
      .collect()
    const people = []
    for (const s of shares) {
      const user = await ctx.db
        .query('users')
        .withIndex('email', (q) => q.eq('email', s.email))
        .first()
      people.push({ _id: s._id, email: s.email, role: s.role, name: user?.name ?? null, joined: !!user })
    }
    return {
      role: a.role,
      owner: owner ? { name: owner.name ?? owner.email ?? 'Owner', email: owner.email ?? '' } : null,
      // Guests who only have the link do not get to see the list of invited people.
      people: a.userId ? people : [],
      linkAccess: a.file.linkAccess === 'view' ? 'view' : 'none',
    }
  },
})

export const invite = mutation({
  args: { fileId: v.id('files'), email: v.string(), role, ...tokenArg },
  handler: async (ctx, { fileId, email, role, token }) => {
    const { userId, file } = await fileAccess(ctx, fileId, token, 'owner')
    const clean = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new ConvexError('Enter a valid email address')
    const owner = file.ownerId ? await ctx.db.get(file.ownerId) : null
    if (owner?.email?.toLowerCase() === clean) throw new ConvexError('That person already owns this file')
    const existing = await ctx.db
      .query('shares')
      .withIndex('by_file_email', (q) => q.eq('fileId', fileId).eq('email', clean))
      .unique()
    if (existing) await ctx.db.patch(existing._id, { role })
    else await ctx.db.insert('shares', { fileId, email: clean, role, invitedBy: userId!, createdAt: Date.now() })
  },
})

export const setRole = mutation({
  args: { shareId: v.id('shares'), role, ...tokenArg },
  handler: async (ctx, { shareId, role, token }) => {
    const share = await ctx.db.get(shareId)
    if (!share) return
    await fileAccess(ctx, share.fileId, token, 'owner')
    await ctx.db.patch(shareId, { role })
  },
})

/** The owner can remove anyone; invited people can remove themselves. */
export const remove = mutation({
  args: { shareId: v.id('shares'), ...tokenArg },
  handler: async (ctx, { shareId, token }) => {
    const share = await ctx.db.get(shareId)
    if (!share) return
    const a = await fileAccess(ctx, share.fileId, token, 'view')
    if (a.role !== 'owner') {
      const user = a.userId ? await ctx.db.get(a.userId) : null
      if (user?.email?.toLowerCase() !== share.email) throw new ConvexError('Only the owner of this file can do that')
    }
    await ctx.db.delete(shareId)
  },
})

export const setLinkAccess = mutation({
  args: { fileId: v.id('files'), linkAccess: v.union(v.literal('none'), v.literal('view')), ...tokenArg },
  handler: async (ctx, { fileId, linkAccess, token }) => {
    await fileAccess(ctx, fileId, token, 'owner')
    await ctx.db.patch(fileId, { linkAccess: linkAccess === 'view' ? 'view' : undefined })
  },
})
