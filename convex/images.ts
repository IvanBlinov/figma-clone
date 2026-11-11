import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { fileAccess, requireUser, tokenArg } from './access'

export const generateUploadUrl = mutation({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token)
    return ctx.storage.generateUploadUrl()
  },
})

/**
 * Upload links for agents: the client sends each file straight to storage (POST the bytes, read { storageId } from the
 * response) instead of passing it through a tool call. Needs edit access to the file the uploads are for.
 */
export const generateUploadUrls = mutation({
  args: { fileId: v.id('files'), count: v.number(), ...tokenArg },
  handler: async (ctx, { fileId, count, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new ConvexError('count must be between 1 and 100')
    const urls: string[] = []
    for (let i = 0; i < count; i++) urls.push(await ctx.storage.generateUploadUrl())
    return urls
  },
})

export const getUrl = mutation({
  args: { storageId: v.id('_storage'), ...tokenArg },
  handler: async (ctx, { storageId, token }) => {
    await requireUser(ctx, token)
    return ctx.storage.getUrl(storageId)
  },
})

/** Where an uploaded file is served from, with its type and size; null if there is no such upload. */
export const info = query({
  args: { storageId: v.string(), ...tokenArg },
  handler: async (ctx, { storageId, token }) => {
    await requireUser(ctx, token)
    const id = ctx.db.system.normalizeId('_storage', storageId)
    const meta = id ? await ctx.db.system.get(id) : null
    const url = id && meta ? await ctx.storage.getUrl(id) : null
    return meta && url ? { url, contentType: meta.contentType ?? null, size: meta.size } : null
  },
})
