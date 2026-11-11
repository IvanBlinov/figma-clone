import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inShard, NODE_SHARDS } from '../shared/shards'
import { newId } from '../shared/types'

test('every id falls in exactly one slice', () => {
  const ids = [...Array.from({ length: 2000 }, () => newId()), '', '0', 'zzzz', 'I12:34', 'new-style:x', '~weird', 'été']
  for (const id of ids) assert.equal(NODE_SHARDS.filter((s) => inShard(s, id)).length, 1, id)
})

test('random ids spread evenly enough over the slices', () => {
  const counts = NODE_SHARDS.map(() => 0)
  for (let i = 0; i < 8000; i++) {
    const id = newId()
    counts[NODE_SHARDS.findIndex((s) => inShard(s, id))]++
  }
  // 62 characters over 8 slices: the last holds 6 of them, the rest 8.
  for (const c of counts) assert.ok(c > 600 && c < 1300, String(counts))
})
