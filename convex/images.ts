import { mutation } from './_generated/server'
import { v } from 'convex/values'
import { requireUser, tokenArg } from './access'

export const generateUploadUrl = mutation({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token)
    return ctx.storage.generateUploadUrl()
  },
})

export const getUrl = mutation({
  args: { storageId: v.id('_storage'), ...tokenArg },
  handler: async (ctx, { storageId, token }) => {
    await requireUser(ctx, token)
    return ctx.storage.getUrl(storageId)
  },
})
