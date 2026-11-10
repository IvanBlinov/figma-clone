import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient } from 'convex/react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Id } from '../convex/_generated/dataModel'
import { OAuthConsent, RequireAuth } from './Account'
import { Editor } from './editor/Editor'
import { Home } from './Home'
import { Player } from './Player'
import './styles.css'

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)

function App() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const oauth = hash.match(/^#\/oauth\/authorize\?(.*)$/)
  if (oauth)
    return (
      <RequireAuth note="Sign in to connect an application to your account.">
        <OAuthConsent query={oauth[1]} />
      </RequireAuth>
    )
  const proto = hash.match(/^#\/proto\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?/)
  if (proto) return <Player key={hash} fileId={proto[1] as Id<'files'>} pageId={proto[2]} frameId={proto[3]} />
  const m = hash.match(/^#\/file\/([\w-]+)/)
  if (m) return <Editor key={m[1]} fileId={m[1] as Id<'files'>} />
  return (
    <RequireAuth>
      <Home />
    </RequireAuth>
  )
}

createRoot(document.getElementById('root')!).render(
  <ConvexAuthProvider client={convex}>
    <App />
  </ConvexAuthProvider>,
)
