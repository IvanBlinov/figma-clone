import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const list = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query('projects').collect()
    const files = await ctx.db.query('files').collect()
    return projects
      .map((p) => {
        const own = files.filter((f) => f.projectId === p._id)
        return {
          _id: p._id,
          name: p.name,
          createdAt: p.createdAt,
          fileCount: own.length,
          updatedAt: own.reduce((m, f) => Math.max(m, f.updatedAt), p.createdAt),
          // A few previews for the project card.
          thumbnails: own
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 4)
            .map((f) => f.thumbnail ?? null),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  },
})

export const create = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => ctx.db.insert('projects', { name: name?.trim() || 'Untitled project', createdAt: Date.now() }),
})

export const rename = mutation({
  args: { projectId: v.id('projects'), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    if (name.trim()) await ctx.db.patch(projectId, { name: name.trim() })
  },
})

/** Delete a project. Its files are kept and become drafts. */
export const remove = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const files = await ctx.db
      .query('files')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    for (const f of files) await ctx.db.patch(f._id, { projectId: undefined })
    await ctx.db.delete(projectId)
  },
})
