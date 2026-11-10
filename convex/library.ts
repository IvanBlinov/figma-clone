// Design-system lookups across files ("libraries") and Code Connect mappings.
import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { accessibleFiles, fileAccess, tokenArg, viewerId } from './access'

/** Every main component and shared style in the workspace, with the file it lives in. */
export const assets = query({
  args: { ...tokenArg },
  handler: async (ctx, { token }) => {
    const userId = await viewerId(ctx, token)
    if (!userId) return { components: [], styles: [], files: [] }
    // Only files the caller owns or was invited to act as libraries.
    const files = (await accessibleFiles(ctx, userId)).map((a) => a.file)
    const fileName = new Map(files.map((f) => [f._id as string, f.name]))
    const nodes = []
    for (const f of files)
      nodes.push(
        ...(await ctx.db
          .query('nodes')
          .withIndex('by_file_nid', (q) => q.eq('fileId', f._id))
          .collect()),
      )
    const byKey = new Map(nodes.map((n) => [n.fileId + ':' + n.nid, n.data]))
    const components = []
    for (const n of nodes) {
      const d = n.data
      if (!d?.isComponent) continue
      const set = d.parentId ? byKey.get(n.fileId + ':' + d.parentId) : undefined
      components.push({
        fileId: n.fileId,
        fileName: fileName.get(n.fileId) ?? '',
        pageId: n.pageId,
        nodeId: n.nid,
        name: d.name as string,
        description: (d.description as string | undefined) ?? '',
        width: d.width as number,
        height: d.height as number,
        componentSet: set?.isComponentSet ? { nodeId: d.parentId as string, name: set.name as string } : null,
      })
    }
    const styleRows = []
    for (const f of files)
      styleRows.push(
        ...(await ctx.db
          .query('styles')
          .withIndex('by_file', (q) => q.eq('fileId', f._id))
          .collect()),
      )
    const styles = styleRows.map((s) => ({
      fileId: s.fileId,
      fileName: fileName.get(s.fileId) ?? '',
      styleId: s._id,
      kind: s.kind,
      name: s.name,
      value: s.value,
    }))
    return { components, styles, files: files.map((f) => ({ fileId: f._id, name: f.name })) }
  },
})

/** A node with its whole subtree (used to copy a component into another file). */
export const subtree = query({
  args: { fileId: v.id('files'), nodeId: v.string(), ...tokenArg },
  handler: async (ctx, { fileId, nodeId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    const root = await ctx.db
      .query('nodes')
      .withIndex('by_file_nid', (q) => q.eq('fileId', fileId).eq('nid', nodeId))
      .unique()
    if (!root) return null
    const page = await ctx.db
      .query('nodes')
      .withIndex('by_page', (q) => q.eq('pageId', root.pageId))
      .collect()
    const out = [root.data]
    const add = (pid: string) => {
      for (const n of page)
        if (n.data.parentId === pid) {
          out.push(n.data)
          add(n.nid)
        }
    }
    add(nodeId)
    return out
  },
})

export const codeConnectList = query({
  args: { fileId: v.id('files'), ...tokenArg },
  handler: async (ctx, { fileId, token }) => {
    await fileAccess(ctx, fileId, token, 'view')
    return ctx.db
      .query('codeConnect')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
  },
})

/** Add or replace the mapping of a node for one framework label. */
export const codeConnectSet = mutation({
  args: {
    fileId: v.id('files'),
    mappings: v.array(
      v.object({
        nodeId: v.string(),
        componentName: v.string(),
        source: v.string(),
        label: v.string(),
        template: v.optional(v.string()),
        templateDataJson: v.optional(v.string()),
      }),
    ),
    ...tokenArg,
  },
  handler: async (ctx, { fileId, mappings, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    const existing = await ctx.db
      .query('codeConnect')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    for (const m of mappings) {
      const old = existing.find((e) => e.nodeId === m.nodeId && e.label === m.label)
      if (old) await ctx.db.patch(old._id, m)
      else await ctx.db.insert('codeConnect', { fileId, ...m })
    }
    return mappings.length
  },
})

export const codeConnectRemove = mutation({
  args: { fileId: v.id('files'), nodeId: v.string(), label: v.optional(v.string()), ...tokenArg },
  handler: async (ctx, { fileId, nodeId, label, token }) => {
    await fileAccess(ctx, fileId, token, 'edit')
    const rows = await ctx.db
      .query('codeConnect')
      .withIndex('by_file', (q) => q.eq('fileId', fileId))
      .collect()
    let n = 0
    for (const r of rows)
      if (r.nodeId === nodeId && (!label || r.label === label)) {
        await ctx.db.delete(r._id)
        n++
      }
    return n
  },
})
