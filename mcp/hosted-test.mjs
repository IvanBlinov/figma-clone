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
expect(!names.includes('use_figma') && !names.includes('login') && !names.includes('logout'), 'machine-local tools are not offered')
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
const png = await client.callTool({ name: 'export_image', arguments: { fileId, nodeId: frameId } })
const image = png.content.find((x) => x.type === 'image')
expect(!!image && Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG', `export_image renders a PNG${image ? ` (${Buffer.from(image.data, 'base64').length} bytes)` : ': ' + JSON.stringify(png.content).slice(0, 200)}`)
if (process.env.SAVE_PNG && image) (await import('node:fs')).writeFileSync(process.env.SAVE_PNG, Buffer.from(image.data, 'base64'))
const localPath = await call('upload_assets', { fileKey: fileId, assets: [{ path: 'C:/Windows/win.ini' }] })
expect(localPath.res.isError && /hosted endpoint/.test(localPath.text), 'local file paths are refused')

await c.mutation(anyApi.files.remove, { fileId })
for (const t of await c.query(anyApi.tokens.list, {})) if (t.name === 'hosted test') await c.mutation(anyApi.tokens.revoke, { tokenId: t._id })
const revoked = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' })
expect(revoked.status === 401, 'revoked token stops working')
await client.close().catch(() => {})
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
