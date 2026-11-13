import { mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { fileMeta, requireUser, tokenArg, viewerId } from './access'

/** The caller's projects with file counts and a few thumbnails. */
export const list = query({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    const userId = await viewerId(ctx, token)
    if (!userId) return []
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .collect()
    const out = []
    for (const p of projects) {
      const rows = await ctx.db
        .query('files')
        .withIndex('by_project', (q) => q.eq('projectId', p._id))
        .collect()
      const own = await Promise.all(rows.map((f) => fileMeta(ctx, f)))
      out.push({
        _id: p._id,
        name: p.name,
        createdAt: p.createdAt,
        fileCount: own.length,
        updatedAt: own.reduce((m, f) => Math.max(m, f.updatedAt), p.createdAt),
        thumbnails: own
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 4)
          .map((f) => f.thumbnail),
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },
})

export const create = mutation({
  args: { name: v.optional(v.string()), ...tokenArg },
  handler: async (ctx, { name, token }) => {
    const userId = await requireUser(ctx, token)
    return ctx.db.insert('projects', { name: name?.trim() || 'Untitled project', createdAt: Date.now(), ownerId: userId })
  },
})

async function own(ctx: MutationCtx, projectId: Id<'projects'>, token?: string) {
  const userId = await requireUser(ctx, token)
  const project = await ctx.db.get(projectId)
  if (!project || project.ownerId !== userId) throw new ConvexError('Project not found')
  return project
}

export const rename = mutation({
  args: { projectId: v.id('projects'), name: v.string(), ...tokenArg },
  handler: async (ctx, { projectId, name, token }) => {
    await own(ctx, projectId, token)
    if (name.trim()) await ctx.db.patch(projectId, { name: name.trim() })
  },
})

/** Delete a project. Its files are kept and become drafts. */
export const remove = mutation({
  args: { projectId: v.id('projects'), ...tokenArg },
  handler: async (ctx, { projectId, token }) => {
    await own(ctx, projectId, token)
    const files = await ctx.db
      .query('files')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    for (const f of files) await ctx.db.patch(f._id, { projectId: undefined })
    await ctx.db.delete(projectId)
  },
})
