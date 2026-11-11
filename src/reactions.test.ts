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

test('swap overlay round-trips', () => {
  const [r] = reactionsFromFigma([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'x', navigation: 'SWAP', transition: null }] }])
  assert.equal(r.action, 'SWAP_OVERLAY')
  assert.equal((reactionsToFigma([r])[0].actions as { navigation: string }[])[0].navigation, 'SWAP')
})

test('links added to a component after its instances exist reach every instance', async () => {
  const { runFigmaCodeInline } = await import('../mcp/figmaApi')
  const pages = [{ pageId: 'p', name: 'P', nodes: [] as never[] }]
  await runFigmaCodeInline(
    `const c = figma.createComponent(); const b = figma.createFrame(); b.name = 'Go'; c.appendChild(b)
     const target = figma.createFrame(); const i = c.createInstance(); i.children[0].name = 'Go'
     const t = i.children[0]; t.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]
     await b.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: target.id, navigation: 'NAVIGATE', transition: null }] }])`,
    pages as never,
    'p',
    [],
    'f',
  )
  const member = (pages[0].nodes as { sourceId?: string; overrides?: string[] }[]).find((n) => n.sourceId)!
  assert.ok(!member.overrides?.includes('reactions'), String(member.overrides))
  assert.ok(member.overrides?.includes('fills'))
})

test('a new text layer sizes itself to its text, so a later fixed width keeps one line', async () => {
  const { runFigmaCodeInline } = await import('../mcp/figmaApi')
  const pages = [{ pageId: 'p', name: 'P', nodes: [] as never[] }]
  await runFigmaCodeInline(`const t = figma.createText(); t.fontSize = 15; t.characters = '472'; t.resize(34, t.height)`, pages as never, 'p', [], 'f')
  const t = (pages[0].nodes as { height: number }[])[0]
  assert.ok(t.height < 20, String(t.height))
})
