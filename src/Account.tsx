// Sign-in, account settings (API tokens), sharing and the OAuth consent screen.
import { useAuthActions } from '@convex-dev/auth/react'
import { useConvexAuth, useMutation, useQuery } from 'convex/react'
import { Check, Copy, Globe, KeyRound, Link2, Lock, LogOut, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { Logo } from './editor/Editor'

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
export const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)))
export async function sha256Hex(text: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

function friendly(e: unknown, signUp: boolean): string {
  const data = (e as { data?: unknown })?.data
  if (typeof data === 'string') return data
  const msg = e instanceof Error ? e.message : String(e)
  if (/InvalidSecret|InvalidAccountId|Invalid credentials/i.test(msg)) return 'Wrong email or password.'
  if (/already exists/i.test(msg)) return 'An account with this email already exists — sign in instead.'
  if (/at least 8/i.test(msg)) return 'Password must be at least 8 characters.'
  if (/valid email/i.test(msg)) return 'Enter a valid email address.'
  if (/TooManyFailedAttempts/i.test(msg)) return 'Too many failed attempts. Wait a little and try again.'
  return signUp ? 'Could not create the account. Check the details and try again.' : 'Could not sign in. Check the details and try again.'
}

/** Email + password sign in / sign up. */
export function AuthForm({ note }: { note?: string }) {
  const { signIn } = useAuthActions()
  const [signUp, setSignUp] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="auth-card"
      onSubmit={async (e) => {
        e.preventDefault()
        setError(null)
        if (signUp && !name.trim()) return setError('Enter your name.')
        if (signUp && password.length < 8) return setError('Password must be at least 8 characters.')
        setBusy(true)
        try {
          await signIn('password', { email: email.trim(), password, flow: signUp ? 'signUp' : 'signIn', ...(signUp ? { name: name.trim() } : {}) })
        } catch (err) {
          setError(friendly(err, signUp))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="auth-brand">
        <Logo /> <b>Figma Clone</b>
      </div>
      <h1>{signUp ? 'Create your account' : 'Sign in'}</h1>
      {note && <p className="auth-note">{note}</p>}
      {signUp && (
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        </label>
      )}
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus={!signUp} required />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signUp ? 'new-password' : 'current-password'} required />
      </label>
      {error && <p className="auth-error">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? 'Please wait…' : signUp ? 'Create account' : 'Sign in'}
      </button>
      <p className="auth-switch">
        {signUp ? 'Already have an account?' : 'New here?'}{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setSignUp(!signUp)
            setError(null)
          }}
        >
          {signUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </form>
  )
}

export function AuthScreen({ note }: { note?: string }) {
  return (
    <div className="auth-screen">
      <AuthForm note={note} />
    </div>
  )
}

/** Renders children once signed in; the sign-in form otherwise. */
export function RequireAuth({ children, note }: { children: React.ReactNode; note?: string }) {
  const { isAuthenticated, isLoading } = useConvexAuth()
  if (isLoading) return <div className="center-msg">Loading…</div>
  return isAuthenticated ? <>{children}</> : <AuthScreen note={note} />
}

// ---------- account settings ----------
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useQuery(api.users.me, {})
  const tokens = useQuery(api.tokens.list, {})
  const createToken = useMutation(api.tokens.create)
  const revoke = useMutation(api.tokens.revoke)
  const rename = useMutation(api.users.rename)
  const [label, setLabel] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string
  const appUrl = location.origin + location.pathname.replace(/\/$/, '')
  return (
    <>
      <div className="popover-backdrop dim" onPointerDown={onClose} />
      <div className="modal wide" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">Account</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <label>
              Name
              <input className="text-input" defaultValue={me?.name ?? ''} key={me?.name} onBlur={(e) => e.target.value.trim() && e.target.value !== me?.name && void rename({ name: e.target.value })} />
            </label>
            <label>
              Email
              <input className="text-input" value={me?.email ?? ''} readOnly />
            </label>
          </div>

          <h3>
            <KeyRound size={14} /> API tokens
          </h3>
          <p className="hint">
            A token lets an agent (the MCP server) act as you: it can see and edit exactly the files you can. Treat it like a password. Agents can also sign in
            through the browser instead (the <code>login</code> tool), which needs no token.
          </p>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault()
              setError(null)
              const token = 'fgc_' + randomHex(32)
              try {
                await createToken({ name: label.trim() || 'API token', hash: await sha256Hex(token), prefix: token.slice(0, 10) })
                setFresh(token)
                setCopied(false)
                setLabel('')
              } catch (err) {
                setError(String((err as { data?: unknown }).data ?? 'Could not create the token'))
              }
            }}
          >
            <input className="text-input grow" placeholder="Token name, e.g. “Claude on my laptop”" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn primary">Create token</button>
          </form>
          {error && <p className="auth-error">{error}</p>}
          {fresh && (
            <div className="token-new">
              <b>Copy this token now — it will not be shown again.</b>
              <div className="row">
                <code className="grow">{fresh}</code>
                <button
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(fresh)
                    setCopied(true)
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="hint">MCP configuration (.mcp.json):</span>
              <pre className="code">{JSON.stringify({ mcpServers: { 'figma-clone': { command: 'node', args: ['mcp/dist/server.mjs'], env: { FIGMA_CLONE_CONVEX_URL: convexUrl, FIGMA_CLONE_APP_URL: appUrl, FIGMA_CLONE_TOKEN: fresh } } } }, null, 2)}</pre>
            </div>
          )}
          <div className="version-list">
            {tokens?.length === 0 && <div className="hint pad">No tokens yet.</div>}
            {tokens?.map((t) => (
              <div className="version" key={t._id}>
                <div className="grow">
                  <b className="ellipsis">{t.name}</b>
                  <span className="time">
                    {t.kind === 'oauth' ? 'Signed in with OAuth' : 'Personal token'} · <code>{t.prefix}…</code> · created {new Date(t.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button className="btn" onClick={() => confirm(`Revoke "${t.name}"? Agents using it lose access immediately.`) && void revoke({ tokenId: t._id })}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

export function AccountBlock() {
  const me = useQuery(api.users.me, {})
  const { signOut } = useAuthActions()
  const [settings, setSettings] = useState(false)
  if (!me) return null
  return (
    <div className="account">
      <span className="avatar self" style={{ background: '#0D99FF' }}>
        {me.name[0]?.toUpperCase()}
      </span>
      <div className="grow">
        <b className="ellipsis">{me.name}</b>
        <span className="ellipsis">{me.email}</span>
      </div>
      <button className="icon-btn" title="Account & API tokens" onClick={() => setSettings(true)}>
        <KeyRound size={14} />
      </button>
      <button className="icon-btn" title="Sign out" onClick={() => void signOut()}>
        <LogOut size={14} />
      </button>
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  )
}

// ---------- sharing ----------
export function ShareDialog({ fileId, onClose }: { fileId: Id<'files'>; onClose: () => void }) {
  const info = useQuery(api.sharing.get, { fileId })
  const invite = useMutation(api.sharing.invite)
  const setRole = useMutation(api.sharing.setRole)
  const remove = useMutation(api.sharing.remove)
  const setLink = useMutation(api.sharing.setLinkAccess)
  const [email, setEmail] = useState('')
  const [role, setNewRole] = useState<'editor' | 'viewer'>('editor')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const owner = info?.role === 'owner'
  return (
    <>
      <div className="popover-backdrop dim" onPointerDown={onClose} />
      <div className="modal" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">Share this file</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          {owner && (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault()
                setError(null)
                try {
                  await invite({ fileId, email, role })
                  setEmail('')
                } catch (err) {
                  setError(String((err as { data?: unknown }).data ?? 'Could not invite'))
                }
              }}
            >
              <input className="text-input grow" type="email" placeholder="Invite by email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <select className="select" value={role} onChange={(e) => setNewRole(e.target.value as 'editor')}>
                <option value="editor">can edit</option>
                <option value="viewer">can view</option>
              </select>
              <button className="btn primary">Invite</button>
            </form>
          )}
          {error && <p className="auth-error">{error}</p>}
          {!owner && info && <p className="hint">You {info.role === 'editor' ? 'can edit' : 'can view'} this file. Only the owner can change who has access.</p>}
          <div className="version-list">
            {info?.owner && (
              <div className="version">
                <div className="grow">
                  <b className="ellipsis">{info.owner.name}</b>
                  <span className="time">{info.owner.email}</span>
                </div>
                <span className="dim">owner</span>
              </div>
            )}
            {info?.people.map((p) => (
              <div className="version" key={p._id}>
                <div className="grow">
                  <b className="ellipsis">{p.name ?? p.email}</b>
                  <span className="time">{p.joined ? p.email : `${p.email} · has not signed up yet`}</span>
                </div>
                {owner ? (
                  <>
                    <select className="select" value={p.role} onChange={(e) => void setRole({ shareId: p._id, role: e.target.value as 'editor' })}>
                      <option value="editor">can edit</option>
                      <option value="viewer">can view</option>
                    </select>
                    <button className="icon-btn" title="Remove access" onClick={() => void remove({ shareId: p._id })}>
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <span className="dim">{p.role === 'editor' ? 'can edit' : 'can view'}</span>
                )}
              </div>
            ))}
          </div>
          <div className="row link-access">
            {info?.linkAccess === 'view' ? <Globe size={16} /> : <Lock size={16} />}
            <div className="grow">
              <b>{info?.linkAccess === 'view' ? 'Anyone with the link can view' : 'Only invited people can open this file'}</b>
              <span className="time">{info?.linkAccess === 'view' ? 'No account needed to look; editing still requires an invitation.' : 'Others see “no access”, even with the link.'}</span>
            </div>
            {owner && (
              <select className="select" value={info?.linkAccess ?? 'none'} onChange={(e) => void setLink({ fileId, linkAccess: e.target.value as 'view' })}>
                <option value="none">Restricted</option>
                <option value="view">Anyone can view</option>
              </select>
            )}
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(location.href)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              <Link2 size={13} /> {copied ? 'Link copied' : 'Copy link'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- OAuth consent ----------
const isLoopback = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
function redirectAllowed(registered: string[], uri: string) {
  try {
    const u = new URL(uri)
    return registered.some((r) => {
      if (r === uri) return true
      const a = new URL(r)
      return isLoopback(a.hostname) && isLoopback(u.hostname) && a.protocol === u.protocol && a.pathname === u.pathname
    })
  } catch {
    return false
  }
}

/** #/oauth/authorize?client_id=…&redirect_uri=…&code_challenge=…&state=… */
export function OAuthConsent({ query }: { query: string }) {
  const q = new URLSearchParams(query)
  const clientId = q.get('client_id') ?? ''
  const redirectUri = q.get('redirect_uri') ?? ''
  const client = useQuery(api.oauth.client, { clientId })
  const me = useQuery(api.users.me, {})
  const approve = useMutation(api.oauth.approve)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  useEffect(() => {
    document.title = 'Authorize – Figma Clone'
  }, [])
  if (client === undefined) return <div className="center-msg">Loading…</div>
  const valid = !!client && redirectAllowed(client.redirectUris, redirectUri) && !!q.get('code_challenge')
  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    const state = q.get('state')
    if (state) u.searchParams.set('state', state)
    setDone(true)
    location.href = u.toString()
  }
  let host = ''
  try {
    host = new URL(redirectUri).host
  } catch {
    /* shown as invalid below */
  }
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo /> <b>Figma Clone</b>
        </div>
        {!valid ? (
          <>
            <h1>Invalid authorization request</h1>
            <p className="auth-note">This link is not a valid sign-in request for a registered application. Nothing was shared. You can close this tab.</p>
          </>
        ) : done ? (
          <>
            <h1>Done</h1>
            <p className="auth-note">Returning to {client!.name}… You can close this tab.</p>
          </>
        ) : (
          <>
            <h1>Allow “{client!.name}” to access your files?</h1>
            <p className="auth-note">
              Signed in as <b>{me?.email}</b>. The application will be able to view and edit every file you can, acting as you, until you revoke it under Account → API tokens.
            </p>
            <p className="auth-note">
              It will be sent back to <code>{host}</code>.
            </p>
            {error && <p className="auth-error">{error}</p>}
            <div className="row consent-actions">
              <button className="btn" onClick={() => back({ error: 'access_denied' })}>
                Deny
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  setError(null)
                  const code = randomHex(32)
                  try {
                    await approve({ clientId, redirectUri, codeChallenge: q.get('code_challenge')!, codeHash: await sha256Hex(code) })
                    back({ code })
                  } catch (err) {
                    setError(String((err as { data?: unknown }).data ?? 'Could not authorize'))
                  }
                }}
              >
                Allow
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
