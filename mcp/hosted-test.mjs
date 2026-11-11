// Checks the hosted MCP endpoint (<deployment>.convex.site/mcp) of the dev deployment with a real MCP client:
// sign-in challenge, tool list, a design round trip and a PNG export.   node mcp/hosted-test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const convexUrl = readFileSync('.env.local', 'utf8').match(/^VITE_CONVEX_URL=(.+)$/m)[1].trim()
const endpoint = convexUrl.replace('.convex.cloud', '.convex.site') + '/mcp'
let failed = 0
const expect = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) failed++
}

// A throwaway account on dev (the same one the smoke test uses) and an API token for it.
const c = new ConvexHttpClient(convexUrl)
const params = { email: 'smoke-alice@example.com', password: 'smoke-test-password-1' }
let session
try {
  session = await c.action(anyApi.auth.signIn, { provider: 'password', params: { ...params, flow: 'signIn' } })
} catch {
  session = await c.action(anyApi.auth.signIn, { provider: 'password', params: { ...params, name: 'Alice', flow: 'signUp' } })
}
c.setAuth(session.tokens.token)
const token = 'fgc_' + randomBytes(32).toString('hex')
await c.mutation(anyApi.tokens.create, { name: 'hosted test', hash: createHash('sha256').update(token).digest('hex'), prefix: token.slice(0, 10) })

const anon = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
expect(anon.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(anon.headers.get('www-authenticate') ?? ''), 'signed-out request gets a 401 pointing at the sign-in metadata')
const meta = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint))).json()
expect(meta.resource === endpoint && meta.authorization_servers?.length === 1, 'protected-resource metadata names the endpoint and the authorization server')
const as = await (await fetch(meta.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json()
expect(!!as.registration_endpoint && !!as.authorization_endpoint && !!as.token_endpoint, 'authorization server metadata is reachable')
const bad = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fgc_bogus' }, body: '{}' })
expect(bad.status === 401, 'unknown token is rejected')

const client = new Client({ name: 'hosted-test', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content.find((x) => x.type === 'text')?.text ?? ''
  let data = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { res, data, text }
}

const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
expect(tools.length >= 65, `tools listed (${tools.length})`)
expect(names.includes('use_figma') && names.includes('create_upload_urls') && !names.includes('login') && !names.includes('logout'), 'use_figma and upload links are offered; login / logout are not')
expect(/hosted endpoint/.test(client.getInstructions() ?? ''), 'instructions describe the hosted endpoint')

const who = await call('whoami')
expect(JSON.stringify(who.data).includes('smoke-alice@example.com'), 'whoami reports the token owner')

const created = await call('create_file', { name: 'Hosted MCP test' })
const fileId = created.data.fileId
expect(typeof fileId === 'string', `create_file (${created.text.slice(0, 80).replace(/\s+/g, ' ')})`)
const made = await call('create_nodes', {
  fileId,
  nodes: [{ type: 'FRAME', name: 'Card', width: 240, height: 120, fill: '#3366FF', cornerRadius: 16, children: [{ type: 'TEXT', characters: 'Hosted', fontSize: 24, fill: '#FFFFFF', x: 24, y: 24 }] }],
})
expect(!made.res.isError, `create_nodes (${made.text.slice(0, 80).replace(/\s+/g, ' ')})`)
const tree = await call('get_tree', { fileId })
expect(tree.text.includes('Card') && tree.text.includes('Hosted'), 'get_tree returns the new layers')
const frameId = made.data.created?.[0]?.id ?? made.data.nodes?.[0]?.id ?? tree.text.match(/"id":\s*"([^"]+)"/)?.[1]
const png = await client.callTool({ name: 'export_image', arguments: { fileId, nodeIds: [frameId] } })
const image = png.content.find((x) => x.type === 'image')
expect(!!image && Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG', `export_image renders a PNG${image ? ` (${Buffer.from(image.data, 'base64').length} bytes)` : ': ' + JSON.stringify(png.content).slice(0, 200)}`)
if (process.env.SAVE_PNG && image) (await import('node:fs')).writeFileSync(process.env.SAVE_PNG, Buffer.from(image.data, 'base64'))
// Scripts run in the sandbox: they can edit the file but cannot reach the server around them.
const script = await call('use_figma', {
  fileKey: fileId,
  description: 'add a section with three cards',
  code: `const s = figma.createSection(); s.name = 'Flow'; s.resizeWithoutConstraints ? s.resizeWithoutConstraints(700, 200) : s.resize(700, 200); s.x = 400
for (let i = 0; i < 3; i++) { const r = figma.createRectangle(); r.name = 'Card ' + i; r.resize(180, 120); r.x = 20 + i * 220; r.y = 40; s.appendChild(r) }
return { type: s.type, cards: s.children.length, env: typeof process + '/' + typeof fetch + '/' + typeof require, ids: s.children.map((c) => c.id) }`,
})
expect(script.data?.result?.type === 'SECTION' && script.data.result.cards === 3 && script.data.changes?.created === 4, `use_figma creates layers (${script.text.slice(0, 90).replace(/\s+/g, ' ')})`)
expect(script.data?.result?.env === 'undefined/undefined/undefined', 'the script has no access to the server process or the network')
const failing = await call('use_figma', { fileKey: fileId, description: 'fails', code: 'figma.createFrame(); throw new Error("boom")' })
expect(failing.res.isError && /boom/.test(failing.text), 'a failing script reports its error')
const looping = await call('use_figma', { fileKey: fileId, description: 'never ends', code: 'while (true) {}' })
expect(looping.res.isError && /timed out/.test(looping.text), 'a runaway script is stopped')
const afterScripts = await call('get_tree', { fileId })
expect((afterScripts.text.match(/"Card \d"/g) ?? []).length === 3 && !/"Frame"/.test(afterScripts.text), 'failed scripts saved nothing')

// Upload links: the bytes go straight to storage, then one call places them.
const cards = script.data?.result?.ids ?? []
const links = await call('create_upload_urls', { fileId, count: 3 })
expect(links.data?.uploadUrls?.length === 3, 'create_upload_urls hands out links')
const pngBytes = Buffer.from(image.data, 'base64')
const storageIds = await Promise.all((links.data?.uploadUrls ?? []).map(async (u) => (await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: pngBytes })).json()).storageId))
const placed = await call('upload_assets', { fileKey: fileId, assets: [...storageIds.slice(0, 2).map((storageId, i) => ({ storageId, nodeId: cards[i] })), { storageId: storageIds[2], name: 'Loose image' }] })
expect(!placed.res.isError && placed.data?.uploaded?.length === 3 && placed.data.uploaded[2].width === 240, `upload_assets places uploaded files (${placed.text.slice(0, 80).replace(/\s+/g, ' ')})`)
const video = await call('create_nodes', { fileId, nodes: [{ type: 'RECTANGLE', name: 'Clip', x: 0, y: 300, width: 160, height: 90, fills: [{ type: 'VIDEO', url: process.env.VIDEO_URL ?? 'https://example.com/clip.mp4' }] }] })
expect(!video.res.isError, 'video fills are accepted')

// Previews: a page id renders the whole page, and the result says which images are in the picture.
const pageId = created.data.pageId
const whole = await client.callTool({ name: 'export_image', arguments: { fileId, nodeIds: [pageId] } })
const wholeText = whole.content.find((x) => x.type === 'text')?.text ?? ''
expect(!!whole.content.find((x) => x.type === 'image') && /whole page/.test(wholeText) && /3 of 4 image\(s\) drawn/.test(wholeText) && /"Clip"/.test(wholeText), `export_image accepts a page id and reports images (${wholeText.slice(0, 160).replace(/\s+/g, ' ')})`)
if (process.env.SAVE_PNG) (await import('node:fs')).writeFileSync(process.env.SAVE_PNG.replace('.png', '-page.png'), Buffer.from(whole.content.find((x) => x.type === 'image').data, 'base64'))
const shot = await client.callTool({ name: 'get_screenshot', arguments: { fileKey: fileId, nodeId: pageId } })
const shotInfo = JSON.parse(shot.content.find((x) => x.type === 'text')?.text ?? '{}')
expect(!shot.isError && shotInfo.images_drawn === 3 && shotInfo.images_total === 4 && /Clip/.test(shotInfo.warning ?? ''), 'get_screenshot accepts a page id and reports images')

// Parameters: unknown names are refused, and the file can be named either way.
const typo = await call('export_image', { fileId, ids: [frameId] })
expect(typo.res.isError && /Unknown parameter "ids" \(did you mean "nodeIds"\?\)/.test(typo.text), `unknown parameters are refused (${typo.text.slice(0, 90)})`)
const aliasA = await call('get_tree', { fileKey: fileId })
const aliasB = await call('get_metadata', { fileId })
expect(!aliasA.res.isError && !aliasB.res.isError, 'fileId and fileKey are interchangeable')
const noFile = await call('get_tree', {})
expect(noFile.res.isError && /fileId is required/.test(noFile.text), 'a missing file id is reported')
const section = await call('create_nodes', { fileId, nodes: [{ type: 'SECTION', name: 'Onboarding', x: 0, y: 500, width: 500, height: 300, children: [{ type: 'FRAME', name: 'Step 1', x: 20, y: 20, width: 120, height: 200 }] }] })
expect(!section.res.isError && /isSection/.test((await call('get_tree', { fileId })).text), 'create_nodes makes sections')

const localPath = await call('upload_assets', { fileKey: fileId, assets: [{ path: 'C:/Windows/win.ini' }] })
expect(localPath.res.isError && /hosted endpoint/.test(localPath.text), 'local file paths are refused')

if (process.env.KEEP_FILE) console.log('kept file', fileId)
else await c.mutation(anyApi.files.remove, { fileId })
for (const t of await c.query(anyApi.tokens.list, {})) if (t.name === 'hosted test') await c.mutation(anyApi.tokens.revoke, { tokenId: t._id })
const revoked = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' })
expect(revoked.status === 401, 'revoked token stops working')
await client.close().catch(() => {})
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
