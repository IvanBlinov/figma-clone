import { mutation } from './_generated/server'
import { v } from 'convex/values'

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
})

export const getUrl = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => ctx.storage.getUrl(storageId),
})
