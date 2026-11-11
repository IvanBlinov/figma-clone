import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runLayout } from '../shared/layout'
import { estimateMeasure } from '../shared/text'
import type { SceneNode } from '../shared/types'

const node = (n: Partial<SceneNode> & Pick<SceneNode, 'id'>): SceneNode => ({ order: 0, type: 'FRAME', name: n.id, x: 0, y: 0, width: 100, height: 100, ...n }) as SceneNode
const base = (fs: number, lh?: number) => ((lh ?? fs * 1.21) - fs * 1.21) / 2 + fs * 0.969

test('a baseline row lines up the first baselines of different text sizes', () => {
  const { index } = runLayout(
    [
      node({ id: 'row', layoutMode: 'HORIZONTAL', counterAxisAlignItems: 'BASELINE', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', itemSpacing: 2 }),
      node({ id: 'big', parentId: 'row', order: 0, type: 'TEXT', characters: '90', fontSize: 22 }),
      node({ id: 'small', parentId: 'row', order: 1, type: 'TEXT', characters: '/ 150g', fontSize: 13 }),
    ],
    estimateMeasure,
  )
  const big = index.byId.get('big')!
  const small = index.byId.get('small')!
  assert.ok(Math.abs(big.y + base(22) - (small.y + base(13))) < 0.01)
  assert.equal(big.y, 0)
  // The row hugs whichever child reaches lowest once moved.
  assert.ok(Math.abs(index.byId.get('row')!.height - Math.max(big.y + big.height, small.y + small.height)) < 0.01)
})

test('without BASELINE the row still top-aligns', () => {
  const { index } = runLayout(
    [
      node({ id: 'row', layoutMode: 'HORIZONTAL', layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' }),
      node({ id: 'a', parentId: 'row', type: 'TEXT', characters: 'A', fontSize: 22 }),
      node({ id: 'b', parentId: 'row', order: 1, type: 'TEXT', characters: 'b', fontSize: 13 }),
    ],
    estimateMeasure,
  )
  assert.equal(index.byId.get('b')!.y, 0)
})
