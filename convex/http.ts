import { httpRouter } from 'convex/server'
import { internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { sha256Hex } from './access'
import { auth } from './auth'

declare const process: { env: Record<string, string | undefined> }

const http = httpRouter()

// Sign-in routes of Convex Auth (JWKS, OpenID configuration).
auth.addHttpRoutes(http)

// ---------- OAuth 2.1 for agents ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } })
const issuer = () => process.env.CONVEX_SITE_URL!
const appUrl = () => (process.env.SITE_URL ?? '').replace(/\/$/, '')
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

const metadata = httpAction(async () =>
  json({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['files'],
  }),
)
http.route({ path: '/.well-known/oauth-authorization-server', method: 'GET', handler: metadata })

for (const path of ['/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token'])
  http.route({ path, method: 'OPTIONS', handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })) })

/** Dynamic client registration (RFC 7591) for public clients. */
http.route({
  path: '/oauth/register',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let body: { client_name?: unknown; redirect_uris?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400)
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
    const valid = uris.filter((u) => {
      try {
        const p = new URL(u)
        // https anywhere, http only on loopback, or a private-use scheme of a native app.
        return p.protocol === 'https:' || (p.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname)) || !['http:', 'https:', 'javascript:', 'data:'].includes(p.protocol)
      } catch {
        return false
      }
    })
    if (!valid.length || valid.length !== uris.length || uris.length > 10) return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, loopback http, or app-scheme URLs' }, 400)
    const clientId = 'fgc-client-' + randomHex(12)
    const name = (typeof body.client_name === 'string' ? body.client_name : 'MCP client').slice(0, 80)
    await ctx.runMutation(internal.oauth.registerClient, { clientId, name, redirectUris: valid })
    return json({ client_id: clientId, client_name: name, redirect_uris: valid, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201)
  }),
})

/** Sends the browser to the app's consent screen, where the user signs in and approves the client. */
http.route({
  path: '/oauth/authorize',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const q = new URL(req.url).searchParams
    const clientId = q.get('client_id') ?? ''
    const client = await ctx.runQuery(internal.oauth.getClient, { clientId })
    if (!client) return new Response('Unknown client_id', { status: 400 })
    if (q.get('response_type') !== 'code') return new Response('Only response_type=code is supported', { status: 400 })
    if (!q.get('code_challenge') || (q.get('code_challenge_method') ?? 'plain') !== 'S256') return new Response('PKCE with code_challenge_method=S256 is required', { status: 400 })
    if (!appUrl()) return new Response('SITE_URL is not configured on this deployment', { status: 500 })
    return new Response(null, { status: 302, headers: { Location: `${appUrl()}/#/oauth/authorize?${q.toString()}` } })
  }),
})

http.route({
  path: '/oauth/token',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const type = req.headers.get('content-type') ?? ''
    let p: URLSearchParams
    if (type.includes('application/json')) p = new URLSearchParams((await req.json()) as Record<string, string>)
    else p = new URLSearchParams(await req.text())
    if (p.get('grant_type') !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400)
    const code = p.get('code')
    const verifier = p.get('code_verifier')
    const clientId = p.get('client_id')
    const redirectUri = p.get('redirect_uri')
    if (!code || !verifier || !clientId || !redirectUri) return json({ error: 'invalid_request', error_description: 'code, code_verifier, client_id and redirect_uri are required' }, 400)
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const token = 'fgc_' + randomHex(32)
    const res = await ctx.runMutation(internal.oauth.exchange, { codeHash: await sha256Hex(code), clientId, redirectUri, challenge, tokenHash: await sha256Hex(token), prefix: token.slice(0, 10) })
    if ('error' in res) return json({ error: res.error, error_description: res.description }, 400)
    return json({ access_token: token, token_type: 'Bearer', scope: 'files' })
  }),
})

export default http
