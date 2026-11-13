// Who is calling, and what they may do with a file.
// Browser clients are identified by their Convex Auth session; agents (MCP) pass an API / OAuth token as the
// `token` argument of each function.
import { getAuthUserId } from '@convex-dev/auth/server'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'

type Ctx = QueryCtx | MutationCtx
export type Role = 'owner' | 'editor' | 'viewer'
export type Need = 'view' | 'edit' | 'owner'

/** Optional `token` argument accepted by every public function. */
export const tokenArg = { token: v.optional(v.string()) }

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function viewerId(ctx: Ctx, token?: string): Promise<Id<'users'> | null> {
  if (token) {
    const hash = await sha256Hex(token)
    const row = await ctx.db
      .query('apiTokens')
      .withIndex('by_hash', (q) => q.eq('hash', hash))
      .unique()
    if (!row || (row.expiresAt && row.expiresAt < Date.now())) throw new ConvexError('Invalid, expired or revoked access token')
    return row.userId
  }
  return getAuthUserId(ctx)
}

export async function requireUser(ctx: Ctx, token?: string): Promise<Id<'users'>> {
  const id = await viewerId(ctx, token)
  if (!id) throw new ConvexError('Not signed in')
  return id
}

export async function roleFor(ctx: Ctx, file: Doc<'files'>, userId: Id<'users'> | null): Promise<Role | null> {
  if (userId && file.ownerId === userId) return 'owner'
  if (userId) {
    const user = await ctx.db.get(userId)
    const email = user?.email?.toLowerCase()
    if (email) {
      const share = await ctx.db
        .query('shares')
        .withIndex('by_file_email', (q) => q.eq('fileId', file._id).eq('email', email))
        .unique()
      if (share) return share.role === 'editor' ? 'editor' : 'viewer'
    }
  }
  return file.linkAccess === 'view' ? 'viewer' : null
}

const allows = (role: Role | null, need: Need) => role === 'owner' || (role === 'editor' && need !== 'owner') || (role === 'viewer' && need === 'view')

/** The file with the caller's role, or null when the file does not exist or the caller may not see it. */
export async function tryAccess(ctx: Ctx, fileId: Id<'files'>, token?: string) {
  const file = await ctx.db.get(fileId)
  if (!file) return null
  const userId = await viewerId(ctx, token)
  const role = await roleFor(ctx, file, userId)
  return role ? { file, userId, role } : null
}

export async function fileAccess(ctx: Ctx, fileId: Id<'files'>, token: string | undefined, need: Need) {
  const a = await tryAccess(ctx, fileId, token)
  // Missing and forbidden files are reported the same way, so ids cannot be probed.
  if (!a) throw new ConvexError('File not found, or you do not have access to it')
  if (!allows(a.role, need)) throw new ConvexError(need === 'owner' ? 'Only the owner of this file can do that' : 'You have view-only access to this file')
  return a
}

export async function pageAccess(ctx: Ctx, pageId: Id<'pages'>, token: string | undefined, need: Need) {
  const page = await ctx.db.get(pageId)
  if (!page) throw new ConvexError('Page not found, or you do not have access to it')
  return { page, ...(await fileAccess(ctx, page.fileId, token, need)) }
}

/** Ids of every file the user owns or has been invited to. */
export async function accessibleFiles(ctx: Ctx, userId: Id<'users'>): Promise<{ file: Doc<'files'>; role: Role }[]> {
  const out: { file: Doc<'files'>; role: Role }[] = []
  const own = await ctx.db
    .query('files')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect()
  for (const file of own) out.push({ file, role: 'owner' })
  const user = await ctx.db.get(userId)
  const email = user?.email?.toLowerCase()
  if (email) {
    const shares = await ctx.db
      .query('shares')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
    for (const s of shares) {
      const file = await ctx.db.get(s.fileId)
      if (file && file.ownerId !== userId) out.push({ file, role: s.role === 'editor' ? 'editor' : 'viewer' })
    }
  }
  return out
}

const metaRow = (ctx: Ctx, fileId: Id<'files'>) =>
  ctx.db
    .query('fileMeta')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .unique()

/** Last-edited time and preview of a file (falls back to the values older files keep on their own row). */
export async function fileMeta(ctx: Ctx, file: Doc<'files'>): Promise<{ updatedAt: number; thumbnail: string | null }> {
  const meta = await metaRow(ctx, file._id)
  return { updatedAt: Math.max(meta?.updatedAt ?? 0, file.updatedAt), thumbnail: meta?.thumbnail ?? file.thumbnail ?? null }
}

/** Marks a file as just edited. Written at most twice a minute, and never to the files row itself. */
export async function touchFile(ctx: MutationCtx, fileId: Id<'files'>) {
  const now = Date.now()
  const meta = await metaRow(ctx, fileId)
  if (!meta) await ctx.db.insert('fileMeta', { fileId, updatedAt: now })
  else if (now - meta.updatedAt > 30_000) await ctx.db.patch(meta._id, { updatedAt: now })
}

/** Points a file at a new preview image in storage and deletes the one it replaces. */
export async function setFileThumbnail(ctx: MutationCtx, file: Doc<'files'>, storageId: Id<'_storage'>) {
  const thumbnail = await ctx.storage.getUrl(storageId)
  if (!thumbnail) return
  const meta = await metaRow(ctx, file._id)
  if (meta) {
    await ctx.db.patch(meta._id, { thumbnail, thumbnailId: storageId })
    if (meta.thumbnailId && meta.thumbnailId !== storageId) await ctx.storage.delete(meta.thumbnailId)
  } else await ctx.db.insert('fileMeta', { fileId: file._id, updatedAt: file.updatedAt, thumbnail, thumbnailId: storageId })
  if (file.thumbnail !== undefined) await ctx.db.patch(file._id, { thumbnail: undefined })
}

export async function deleteFileMeta(ctx: MutationCtx, fileId: Id<'files'>) {
  const meta = await metaRow(ctx, fileId)
  if (!meta) return
  if (meta.thumbnailId) await ctx.storage.delete(meta.thumbnailId)
  await ctx.db.delete(meta._id)
}
