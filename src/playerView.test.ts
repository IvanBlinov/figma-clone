import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIndex } from '../shared/doc'
import type { SceneNode } from '../shared/types'
import { frameView, overlayOrigin, scrollBy, viewportOf } from './playerView'

const node = (n: Partial<SceneNode> & Pick<SceneNode, 'id'>): SceneNode => ({ order: 0, type: 'FRAME', name: n.id, x: 0, y: 0, width: 100, height: 100, ...n }) as SceneNode
const phone = { width: 402, height: 874 }

// A tall screen inside a section, with content, a header that scrolls, a tab bar pinned to the bottom and a carousel.
const screen = () =>
  buildIndex([
    node({ id: 'section', isSection: true, x: 500, y: 300, width: 2000, height: 3000 }),
    node({ id: 'today', parentId: 'section', x: 40, y: 60, width: 402, height: 1600 }),
    node({ id: 'title', parentId: 'today', type: 'TEXT', order: 0, x: 16, y: 70, width: 200, height: 30 }),
    node({ id: 'tabs', parentId: 'today', order: 2, x: 16, y: 1520, width: 370, height: 62, scrollBehavior: 'FIXED', constraints: { vertical: 'MAX' } }),
    node({ id: 'close', parentId: 'today', order: 3, x: 350, y: 20, width: 40, height: 40, scrollBehavior: 'FIXED' }),
    node({ id: 'carousel', parentId: 'today', order: 1, x: 0, y: 400, width: 402, height: 120, overflowDirection: 'HORIZONTAL' }),
    node({ id: 'card1', parentId: 'carousel', order: 0, x: 16, y: 0, width: 300, height: 120 }),
    node({ id: 'card2', parentId: 'carousel', order: 1, x: 326, y: 0, width: 300, height: 120 }),
  ])

test('a frame taller than the device is cut to the device and can scroll the difference', () => {
  const v = frameView(screen(), 'today', phone, {})
  assert.equal(v.width, 402)
  assert.equal(v.height, 874)
  assert.deepEqual(v.ranges.get('today'), { x: 0, y: 1600 - 874 })
  const root = v.ix.byId.get('today')!
  assert.equal(root.parentId, undefined)
  assert.equal(root.x, 0)
  assert.equal(root.clipsContent, true)
  assert.equal(v.ix.byId.has('section'), false)
})

test('without a device, or with overflow NONE, the whole frame is shown', () => {
  const ix = screen()
  assert.deepEqual(viewportOf(ix.byId.get('today')!, null), { width: 402, height: 1600 })
  assert.deepEqual(viewportOf({ ...ix.byId.get('today')!, overflowDirection: 'NONE' }, phone), { width: 402, height: 1600 })
  assert.equal(frameView(ix, 'today', null, {}).ranges.has('today'), false)
})

test('scrolling moves content but not fixed layers; a bottom-constrained fixed layer sticks to the device bottom', () => {
  const v = frameView(screen(), 'today', phone, { today: { x: 0, y: 300 } })
  assert.equal(v.ix.byId.get('title')!.y, 70 - 300)
  assert.equal(v.ix.byId.get('carousel')!.y, 400 - 300)
  assert.equal(v.ix.byId.get('tabs')!.y, 1520 - (1600 - 874))
  assert.equal(v.ix.byId.get('close')!.y, 20)
})

test('offsets past the end are clamped', () => {
  const v = frameView(screen(), 'today', phone, { today: { x: 0, y: 99999 } })
  assert.equal(v.ix.byId.get('title')!.y, 70 - 726)
  const w = frameView(screen(), 'today', phone, { today: { x: 0, y: -50 } })
  assert.equal(w.ix.byId.get('title')!.y, 70)
})

test('a nested frame with overflow scrolls its own children', () => {
  const v = frameView(screen(), 'today', phone, { carousel: { x: 100, y: 0 } })
  assert.deepEqual(v.ranges.get('carousel'), { x: 626 - 402, y: 0 })
  assert.equal(v.ix.byId.get('card1')!.x, 16 - 100)
  assert.equal(v.ix.byId.get('carousel')!.x, 0)
})

test('scrollBy gives the delta to the deepest frame that can move along the main axis', () => {
  const v = frameView(screen(), 'today', phone, {})
  // A vertical swipe over the carousel scrolls the screen, a horizontal one the carousel.
  assert.deepEqual(scrollBy(v, {}, ['card1', 'carousel', 'today'], 0, 120), { today: { x: 0, y: 120 } })
  assert.deepEqual(scrollBy(v, {}, ['card1', 'carousel', 'today'], 80, 10), { carousel: { x: 80, y: 0 } })
  // Nothing left to scroll that way.
  assert.equal(scrollBy(v, {}, ['today'], 0, -40), null)
  assert.equal(scrollBy(v, { today: { x: 0, y: 726 } }, ['today'], 0, 40), null)
})

test('scrollBy does not change the offsets it was given', () => {
  const v = frameView(screen(), 'today', phone, {})
  const before = { today: { x: 0, y: 10 } }
  scrollBy(v, before, ['today'], 0, 50)
  assert.deepEqual(before, { today: { x: 0, y: 10 } })
})

test('overlay positions follow Figma', () => {
  const stage = { x: 100, y: 50, w: 402, h: 874 }
  assert.deepEqual(overlayOrigin(undefined, stage, 300, 200), { x: 151, y: 387 })
  assert.deepEqual(overlayOrigin('BOTTOM_CENTER', stage, 402, 600), { x: 100, y: 324 })
  assert.deepEqual(overlayOrigin('TOP_LEFT', stage, 200, 100), { x: 100, y: 50 })
  assert.deepEqual(overlayOrigin('TOP_RIGHT', stage, 200, 100), { x: 302, y: 50 })
})
