import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { fileAccess, requireUser, tokenArg } from './access'

export const list = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    return ctx.db
      .query('comments')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
  },
})

/** Commenting needs an account and at least view access (viewers may comment, like in Figma). */
async function commenter(ctx: MutationCtx, commentId: Id<'comments'>, token?: string) {
  const userId = await requireUser(ctx, token)
  const comment = await ctx.db.get(commentId)
  if (!comment) throw new ConvexError('Comment not found')
  const { role } = await fileAccess(ctx, comment.fileId, token, 'view')
  return { comment, userId, role }
}

export const add = mutation({
  args: {
    fileId: v.id('files'),
    pageId: v.id('pages'),
    x: v.number(),
    y: v.number(),
    author: v.string(),
    color: v.optional(v.string()),
    text: v.string(),
    ...tokenArg,
  },
  handler: async (ctx, { token, ...args }) => {
    const userId = await requireUser(ctx, token)
    await fileAccess(ctx, args.fileId, token, 'view')
    const page = await ctx.db.get(args.pageId)
    if (!page || page.fileId !== args.fileId) throw new ConvexError('Page not found in this file')
    return ctx.db.insert('comments', { ...args, userId, resolved: false, replies: [] })
  },
})

export const reply = mutation({
  args: { commentId: v.id('comments'), author: v.string(), text: v.string(), ...tokenArg },
  handler: async (ctx, { commentId, author, text, token }) => {
    const { comment } = await commenter(ctx, commentId, token)
    await ctx.db.patch(commentId, { replies: [...comment.replies, { author, text, createdAt: Date.now() }] })
  },
})

export const setResolved = mutation({
  args: { commentId: v.id('comments'), resolved: v.boolean(), ...tokenArg },
  handler: async (ctx, { commentId, resolved, token }) => {
    await commenter(ctx, commentId, token)
    await ctx.db.patch(commentId, { resolved })
  },
})

/** Authors can delete their own comments; editors and owners can delete any. */
export const remove = mutation({
  args: { commentId: v.id('comments'), ...tokenArg },
  handler: async (ctx, { commentId, token }) => {
    const { comment, userId, role } = await commenter(ctx, commentId, token)
    if (role === 'viewer' && comment.userId !== userId) throw new ConvexError('You can only delete your own comments')
    await ctx.db.delete(commentId)
  },
})
