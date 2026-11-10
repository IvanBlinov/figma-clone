// How the MCP server proves who it is acting for.
//   1. HTTP mode: the bearer token of the current request (set per request).
//   2. FIGMA_CLONE_TOKEN: a personal API token created in the app (Account → API tokens).
//   3. A token obtained through the browser sign-in (`login` tool, OAuth 2.1 + PKCE), cached in ~/.figma-clone.
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

export const requestToken = new AsyncLocalStorage<string>()

const DIR = join(homedir(), '.figma-clone')
const FILE = join(DIR, 'credentials.json')

function readStore(): Record<string, { token: string; savedAt: number }> {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
  } catch {
    return {}
  }
}
function writeStore(store: Record<string, unknown>) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function currentToken(convexUrl: string): { token: string; source: 'request' | 'env' | 'login' } | null {
  const req = requestToken.getStore()
  if (req) return { token: req, source: 'request' }
  if (process.env.FIGMA_CLONE_TOKEN) return { token: process.env.FIGMA_CLONE_TOKEN, source: 'env' }
  const saved = readStore()[convexUrl]
  return saved ? { token: saved.token, source: 'login' } : null
}

export function forgetToken(convexUrl: string): boolean {
  const store = readStore()
  if (!store[convexUrl]) return false
  delete store[convexUrl]
  writeStore(store)
  return true
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function openBrowser(url: string) {
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  } catch {
    /* the URL is also returned to the caller */
  }
}

let pending: { url: string; done: Promise<void> } | null = null

/**
 * Start (or continue) the browser sign-in. Resolves `done` once the user approved and the token is stored.
 * The sign-in page stays valid for five minutes.
 */
export async function startLogin(convexUrl: string, siteUrl: string): Promise<{ url: string; done: Promise<void> }> {
  if (pending) return pending
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  let finish!: () => void
  let fail!: (e: Error) => void
  const done = new Promise<void>((res, rej) => {
    finish = res
    fail = rej
  })
  done.catch(() => {})
  let clientId = ''
  let redirect = ''
  const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f5"><div style="background:#fff;padding:28px 32px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.12);max-width:360px"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#555">${text}</p></div></body>`
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const end = (ok: boolean, title: string, text: string, err?: Error) => {
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, text))
      server.close()
      clearTimeout(timer)
      pending = null
      if (ok) finish()
      else fail(err ?? new Error(text))
    }
    if (u.searchParams.get('state') !== state) return end(false, 'Sign-in failed', 'The response did not match this sign-in request. Start again from your agent.')
    if (u.searchParams.get('error')) return end(false, 'Access denied', 'You declined the request. Nothing was shared. You can close this tab.', new Error('The request was denied in the browser'))
    try {
      const r = await fetch(`${siteUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code') ?? '', code_verifier: verifier, client_id: clientId, redirect_uri: redirect }),
      })
      const body = (await r.json()) as { access_token?: string; error_description?: string; error?: string }
      if (!r.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `HTTP ${r.status}`)
      writeStore({ ...readStore(), [convexUrl]: { token: body.access_token, savedAt: Date.now() } })
      end(true, 'Signed in', 'Your agent is now connected. You can close this tab.')
    } catch (e) {
      end(false, 'Sign-in failed', 'The server rejected the sign-in. Start again from your agent.', e as Error)
    }
  })
  await new Promise<void>((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', res))
  const port = (server.address() as { port: number }).port
  redirect = `http://127.0.0.1:${port}/callback`
  const timer = setTimeout(() => {
    server.close()
    pending = null
    fail(new Error('Sign-in timed out'))
  }, 5 * 60_000)
  timer.unref()
  try {
    const reg = await fetch(`${siteUrl}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: `Figma Clone MCP on ${hostname()}`, redirect_uris: [redirect] }) })
    const body = (await reg.json()) as { client_id?: string; error_description?: string }
    if (!reg.ok || !body.client_id) throw new Error(body.error_description ?? `Could not register with the server (HTTP ${reg.status})`)
    clientId = body.client_id
  } catch (e) {
    server.close()
    clearTimeout(timer)
    throw e
  }
  const url = `${siteUrl}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'files' })}`
  openBrowser(url)
  pending = { url, done }
  return pending
}
