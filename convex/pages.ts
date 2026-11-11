import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { fileAccess, pageAccess, tokenArg } from './access'

export const list = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    return pages.sort((a, b) => a.order - b.order)
  },
})

export const create = mutation({
  args: { fileId: v.id('files'), name: v.optional(v.string()), ...tokenArg },
  handler: async (ctx, { fileId, name, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    const order = pages.reduce((m, p) => Math.max(m, p.order), -1) + 1
    return ctx.db.insert('pages', { fileId, name: name || `Page ${pages.length + 1}`, order })
  },
})

const device = v.object({ name: v.optional(v.string()), width: v.number(), height: v.number() })

export const update = mutation({
  args: {
    pageId: v.id('pages'),
    name: v.optional(v.string()),
    background: v.optional(v.string()),
    /** null removes the device, so prototypes show whole frames again. */
    prototypeDevice: v.optional(v.union(device, v.null())),
    ...tokenArg,
  },
  handler: async (ctx, { pageId, name, background, prototypeDevice, token }) => {
    await pageAccess(ctx, pageId, token, 'edit')
    if (prototypeDevice && !(prototypeDevice.width >= 1 && prototypeDevice.height >= 1 && prototypeDevice.width <= 10000 && prototypeDevice.height <= 10000))
      throw new ConvexError('A prototype device must be between 1 and 10000 px on each side')
    const patch: { name?: string; background?: string; prototypeDevice?: { name?: string; width: number; height: number } | undefined } = {}
    if (name !== undefined) patch.name = name
    if (background !== undefined) patch.background = background
    if (prototypeDevice !== undefined) patch.prototypeDevice = prototypeDevice ?? undefined
    await ctx.db.patch(pageId, patch)
  },
})

export const remove = mutation({
  args: { pageId: v.id('pages'), ...tokenArg },
  handler: async (ctx, { pageId, token }) => {
    const { page } = await pageAccess(ctx, pageId, token, 'edit')
    const pages = await ctx.db
      .query('pages')
      .withIndex('by_file', (q) => q.eq('fileId', page.fileId))
      .collect()
    if (pages.length <= 1) throw new ConvexError('A file must keep at least one page')
    const nodes = await ctx.db
      .query('nodes')
      .withIndex('by_page', (q) => q.eq('pageId', pageId))
      .collect()
    for (const n of nodes) await ctx.db.delete(n._id)
    await ctx.db.delete(pageId)
  },
})
