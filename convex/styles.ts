import { mutation, query, type MutationCtx } from './_generated/server'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'

export const list = query({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) =>
    ctx.db
      .query('styles')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect(),
})

export const create = mutation({
  args: { fileId: v.id('files'), kind: v.union(v.literal('PAINT'), v.literal('TEXT')), name: v.string(), value: v.any() },
  handler: async (ctx, args) => ctx.db.insert('styles', args),
})

/** Push a style's value into (or unlink it from) every node of the file that references it. */
async function propagate(ctx: MutationCtx, fileId: Id<'files'>, styleId: string, kind: string, value: { paints?: unknown; text?: Record<string, unknown> } | null) {
  const rows = await ctx.db
    .query('nodes')
    .withIndex('by_file_nid', (q) => q.eq('fileId', fileId))
    .collect()
  for (const row of rows) {
    const d = row.data
    const next: Record<string, unknown> = { ...d }
    let changed = false
    if (kind === 'PAINT') {
      if (d.fillStyleId === styleId) {
        changed = true
        if (value) next.fills = value.paints ?? []
        else delete next.fillStyleId
      }
      if (d.strokeStyleId === styleId) {
        changed = true
        if (value) next.strokes = value.paints ?? []
        else delete next.strokeStyleId
      }
    } else if (d.textStyleId === styleId) {
      changed = true
      if (value) Object.assign(next, value.text ?? {})
      else delete next.textStyleId
    }
    if (changed) await ctx.db.patch(row._id, { data: next })
  }
}

export const update = mutation({
  args: { styleId: v.id('styles'), name: v.optional(v.string()), value: v.optional(v.any()) },
  handler: async (ctx, { styleId, name, value }) => {
    const style = await ctx.db.get(styleId)
    if (!style) throw new Error('Style not found')
    await ctx.db.patch(styleId, { ...(name !== undefined ? { name } : {}), ...(value !== undefined ? { value } : {}) })
    if (value !== undefined) {
      await propagate(ctx, style.fileId, styleId, style.kind, value)
      await ctx.db.patch(style.fileId, { updatedAt: Date.now() })
    }
  },
})

export const remove = mutation({
  args: { styleId: v.id('styles') },
  handler: async (ctx, { styleId }) => {
    const style = await ctx.db.get(styleId)
    if (!style) return
    await propagate(ctx, style.fileId, styleId, style.kind, null)
    await ctx.db.delete(styleId)
  },
})
