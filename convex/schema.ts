import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  // users, sessions and accounts (email + password) managed by Convex Auth.
  ...authTables,
  // Projects group files; a file without a project is a draft. Projects are private to their owner.
  projects: defineTable({
    name: v.string(),
    createdAt: v.number(),
    ownerId: v.optional(v.id('users')),
  }).index('by_owner', ['ownerId']),
  files: defineTable({
    name: v.string(),
    updatedAt: v.number(),
    thumbnail: v.optional(v.string()),
    projectId: v.optional(v.id('projects')),
    ownerId: v.optional(v.id('users')),
    // 'view' = anyone with the link can open the file read-only (even signed out).
    linkAccess: v.optional(v.string()),
  })
    .index('by_project', ['projectId'])
    .index('by_owner', ['ownerId']),
  // People a file is shared with, by (lower-cased) email so invitations work before the person signs up.
  shares: defineTable({
    fileId: v.id('files'),
    email: v.string(),
    role: v.string(), // 'editor' | 'viewer'
    invitedBy: v.id('users'),
    createdAt: v.number(),
  })
    .index('by_file_email', ['fileId', 'email'])
    .index('by_email', ['email']),
  // Access tokens for agents: personal API tokens and tokens issued through the OAuth flow.
  // Only the SHA-256 hash is stored.
  apiTokens: defineTable({
    userId: v.id('users'),
    name: v.string(),
    hash: v.string(),
    prefix: v.string(),
    kind: v.string(), // 'pat' | 'oauth'
    clientId: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  })
    .index('by_hash', ['hash'])
    .index('by_user', ['userId']),
  // OAuth 2.1 public clients (dynamic registration) and pending authorization codes (PKCE).
  oauthClients: defineTable({
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    createdAt: v.number(),
  }).index('by_client', ['clientId']),
  oauthCodes: defineTable({
    hash: v.string(),
    userId: v.id('users'),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    expiresAt: v.number(),
  }).index('by_hash', ['hash']),
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
    userId: v.optional(v.id('users')),
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
