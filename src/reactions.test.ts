import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactionsFromFigma, reactionsToFigma } from '../mcp/figmaApi'

test("Figma's reaction shape becomes this file's", () => {
  const out = reactionsFromFigma([
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'a', navigation: 'NAVIGATE', transition: { type: 'PUSH', direction: 'LEFT', duration: 0.3, easing: { type: 'EASE_OUT' } } }] },
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'sheet', navigation: 'OVERLAY', transition: { type: 'MOVE_IN', direction: 'TOP', duration: 0.35, easing: { type: 'EASE_OUT' } } }] },
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] },
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] },
    { trigger: { type: 'AFTER_TIMEOUT', timeout: 1.2 }, actions: [{ type: 'NODE', destinationId: 'b', navigation: 'NAVIGATE', transition: null }] },
  ])
  assert.deepEqual(out, [
    { trigger: 'ON_CLICK', action: 'NAVIGATE', destinationId: 'a', transition: 'PUSH', direction: 'LEFT', duration: 300, easing: 'EASE_OUT' },
    { trigger: 'ON_CLICK', action: 'OVERLAY', destinationId: 'sheet', transition: 'MOVE_IN', direction: 'TOP', duration: 350, easing: 'EASE_OUT' },
    { trigger: 'ON_CLICK', action: 'BACK' },
    { trigger: 'ON_CLICK', action: 'CLOSE_OVERLAY' },
    { trigger: 'AFTER_TIMEOUT', timeout: 1200, action: 'NAVIGATE', destinationId: 'b', transition: 'INSTANT' },
  ])
})

test('round trip keeps the meaning', () => {
  const mine = [{ trigger: 'ON_CLICK' as const, action: 'OVERLAY' as const, destinationId: 's', transition: 'MOVE_IN' as const, direction: 'TOP' as const, duration: 350, easing: 'EASE_OUT' as const }]
  assert.deepEqual(reactionsFromFigma(reactionsToFigma(mine)), mine)
})
