import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Id } from '../convex/_generated/dataModel'
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
  const proto = hash.match(/^#\/proto\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?/)
  if (proto) return <Player key={hash} fileId={proto[1] as Id<'files'>} pageId={proto[2]} frameId={proto[3]} />
  const m = hash.match(/^#\/file\/([\w-]+)/)
  return m ? <Editor key={m[1]} fileId={m[1] as Id<'files'>} /> : <Home />
}

createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={convex}>
    <App />
  </ConvexProvider>,
)
