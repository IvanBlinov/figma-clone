import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const list = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) =>
    ctx.db
      .query('comments')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect(),
})

export const add = mutation({
  args: {
    fileId: v.id('files'),
    pageId: v.id('pages'),
    x: v.number(),
    y: v.number(),
    author: v.string(),
    color: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => ctx.db.insert('comments', { ...args, resolved: false, replies: [] }),
})

export const reply = mutation({
  args: { commentId: v.id('comments'), author: v.string(), text: v.string() },
  handler: async (ctx, { commentId, author, text }) => {
    const c = await ctx.db.get(commentId)
    if (!c) throw new Error('Comment not found')
    await ctx.db.patch(commentId, { replies: [...c.replies, { author, text, createdAt: Date.now() }] })
  },
})

export const setResolved = mutation({
  args: { commentId: v.id('comments'), resolved: v.boolean() },
  handler: async (ctx, { commentId, resolved }) => {
    await ctx.db.patch(commentId, { resolved })
  },
})

export const remove = mutation({
  args: { commentId: v.id('comments') },
  handler: async (ctx, { commentId }) => {
    await ctx.db.delete(commentId)
  },
})
