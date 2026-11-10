// OAuth 2.1 authorization-code flow with PKCE for agents (MCP clients).
// The HTTP endpoints live in http.ts; this file holds the database side.
import { internalMutation, internalQuery, mutation, query } from './_generated/server'
import { ConvexError, v } from 'convex/values'
import { requireUser } from './access'

const loopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]'

/** Exact match, except that loopback redirect URIs may use any port (RFC 8252). */
export function redirectAllowed(registered: string[], uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  return registered.some((r) => {
    if (r === uri) return true
    try {
      const a = new URL(r)
      return loopback(a.hostname) && loopback(u.hostname) && a.protocol === u.protocol && a.pathname === u.pathname
    } catch {
      return false
    }
  })
}

/** Shown on the consent screen. */
export const client = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const c = await ctx.db
      .query('oauthClients')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique()
    return c ? { name: c.name, redirectUris: c.redirectUris } : null
  },
})

/**
 * The signed-in user approves a client. The browser generates the authorization code and sends its hash,
 * so the code itself is never stored.
 */
export const approve = mutation({
  args: { clientId: v.string(), redirectUri: v.string(), codeChallenge: v.string(), codeHash: v.string() },
  handler: async (ctx, { clientId, redirectUri, codeChallenge, codeHash }) => {
    const userId = await requireUser(ctx)
    const c = await ctx.db
      .query('oauthClients')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique()
    if (!c) throw new ConvexError('Unknown application')
    if (!redirectAllowed(c.redirectUris, redirectUri)) throw new ConvexError('This redirect address is not registered for the application')
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || !/^[0-9a-f]{64}$/.test(codeHash)) throw new ConvexError('Malformed authorization request')
    await ctx.db.insert('oauthCodes', { hash: codeHash, userId, clientId, redirectUri, codeChallenge, expiresAt: Date.now() + 10 * 60_000 })
  },
})

export const registerClient = internalMutation({
  args: { clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert('oauthClients', { ...args, createdAt: Date.now() })
  },
})

export const getClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) =>
    ctx.db
      .query('oauthClients')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique(),
})

/** Redeem an authorization code (single use) and store the hash of the access token issued for it. */
export const exchange = internalMutation({
  args: { codeHash: v.string(), clientId: v.string(), redirectUri: v.string(), challenge: v.string(), tokenHash: v.string(), prefix: v.string() },
  handler: async (ctx, { codeHash, clientId, redirectUri, challenge, tokenHash, prefix }) => {
    const code = await ctx.db
      .query('oauthCodes')
      .withIndex('by_hash', (q) => q.eq('hash', codeHash))
      .unique()
    if (!code) return { error: 'invalid_grant', description: 'Unknown or already used authorization code' }
    await ctx.db.delete(code._id)
    if (code.expiresAt < Date.now()) return { error: 'invalid_grant', description: 'Authorization code expired' }
    if (code.clientId !== clientId) return { error: 'invalid_grant', description: 'Code was issued to a different client' }
    if (code.redirectUri !== redirectUri) return { error: 'invalid_grant', description: 'redirect_uri does not match' }
    if (code.codeChallenge !== challenge) return { error: 'invalid_grant', description: 'PKCE verification failed' }
    const c = await ctx.db
      .query('oauthClients')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique()
    await ctx.db.insert('apiTokens', { userId: code.userId, name: c?.name ?? 'OAuth application', hash: tokenHash, prefix, kind: 'oauth', clientId, createdAt: Date.now() })
    return { ok: true }
  },
})
