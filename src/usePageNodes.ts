import { useQuery } from 'convex/react'
import { useMemo } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { inShard, NODE_SHARDS } from '../shared/shards'
import { applyOpsToList } from '../shared/doc'
import type { Op, SceneNode } from '../shared/types'

/**
 * All layers of a page, read as one live query per id slice (see shared/shards.ts) so a large page never exceeds a
 * query's time limit. Undefined until every slice has loaded.
 */
export function usePageNodes(pageId: Id<'pages'> | null | undefined): SceneNode[] | undefined {
  // The number of slices is fixed, so the hooks are always called in the same order.
  const parts = NODE_SHARDS.map((s) => useQuery(api.nodes.listRange, pageId ? { pageId, from: s.from, to: s.to } : 'skip') as SceneNode[] | undefined)
  return useMemo(() => (parts.every((p) => p !== undefined) ? (parts as SceneNode[][]).flat() : undefined), parts) // eslint-disable-line react-hooks/exhaustive-deps
}

type Store = {
  getQuery: (q: typeof api.nodes.listRange, a: { pageId: Id<'pages'>; from: string; to: string }) => unknown
  setQuery: (q: typeof api.nodes.listRange, a: { pageId: Id<'pages'>; from: string; to: string }, v: SceneNode[]) => void
}

/** Optimistic update for applyOps: each slice gets the ops on its own layers. */
export function applyOpsToSlices(store: Store, pageId: Id<'pages'>, ops: Op[]) {
  for (const s of NODE_SHARDS) {
    const args = { pageId, from: s.from, to: s.to }
    const cur = store.getQuery(api.nodes.listRange, args) as SceneNode[] | undefined
    const mine = ops.filter((o) => inShard(s, o.op === 'create' ? o.node.id : o.id))
    if (cur && mine.length) store.setQuery(api.nodes.listRange, args, applyOpsToList(cur, mine))
  }
}
