import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  // Projects group files; a file without a project is a draft.
  projects: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
  files: defineTable({
    name: v.string(),
    updatedAt: v.number(),
    thumbnail: v.optional(v.string()),
    projectId: v.optional(v.id('projects')),
  }).index('by_project', ['projectId']),
  pages: defineTable({
    fileId: v.id('files'),
    name: v.string(),
    order: v.number(),
    background: v.optional(v.string()),
  }).index('by_file', ['fileId']),
  // One row per scene node. `data` is the full node JSON (see shared/types.ts);
  // `nid` is the client-generated node id so undo/redo can restore identity.
  nodes: defineTable({
    fileId: v.id('files'),
    pageId: v.id('pages'),
    nid: v.string(),
    data: v.any(),
  })
    .index('by_page', ['pageId'])
    .index('by_file_nid', ['fileId', 'nid']),
  presence: defineTable({
    fileId: v.id('files'),
    sessionId: v.string(),
    name: v.string(),
    color: v.string(),
    pageId: v.optional(v.string()),
    x: v.number(),
    y: v.number(),
    selection: v.array(v.string()),
    isAgent: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index('by_file', ['fileId'])
    .index('by_session', ['sessionId']),
  comments: defineTable({
    fileId: v.id('files'),
    pageId: v.id('pages'),
    x: v.number(),
    y: v.number(),
    author: v.string(),
    color: v.optional(v.string()),
    text: v.string(),
    resolved: v.boolean(),
    replies: v.array(v.object({ author: v.string(), text: v.string(), createdAt: v.number() })),
  }).index('by_file', ['fileId']),
  // Shared colour / text styles. Nodes reference them via fillStyleId / strokeStyleId / textStyleId.
  styles: defineTable({
    fileId: v.id('files'),
    kind: v.string(),
    name: v.string(),
    value: v.any(),
  }).index('by_file', ['fileId']),
  // Version history: a snapshot of every page and node of a file.
  versions: defineTable({
    fileId: v.id('files'),
    label: v.string(),
    author: v.optional(v.string()),
    createdAt: v.number(),
    nodeCount: v.number(),
    pages: v.array(v.object({ pageId: v.string(), name: v.string(), order: v.number(), background: v.optional(v.string()) })),
  }).index('by_file', ['fileId']),
  versionNodes: defineTable({
    versionId: v.id('versions'),
    pageId: v.string(),
    nid: v.string(),
    data: v.any(),
  }).index('by_version', ['versionId']),
  // Code Connect: which code component a design node corresponds to (per framework label).
  codeConnect: defineTable({
    fileId: v.id('files'),
    nodeId: v.string(),
    componentName: v.string(),
    source: v.string(),
    label: v.string(),
    template: v.optional(v.string()),
    templateDataJson: v.optional(v.string()),
  }).index('by_file', ['fileId']),
  // Commands pushed by agents (MCP) to connected editors: select nodes, focus viewport.
  commands: defineTable({
    fileId: v.id('files'),
    type: v.string(),
    payload: v.any(),
  }).index('by_file', ['fileId']),
})
