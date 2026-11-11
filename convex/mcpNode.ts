'use node'
// The MCP server running inside the deployment: one stateless JSON-RPC exchange per call (see the /mcp route in http.ts).
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { v } from 'convex/values'
import { makeServer, requestToken } from '../mcp/server'
import { internalAction } from './_generated/server'

export const handle = internalAction({
  args: { token: v.string(), url: v.string(), headers: v.record(v.string(), v.string()), body: v.string() },
  handler: async (_ctx, { token, url, headers, body }) => {
    const server = makeServer(true)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    try {
      // Every backend call made while handling this message carries the caller's token.
      return await requestToken.run(token, async () => {
        await server.connect(transport)
        const res = await transport.handleRequest(new Request(url, { method: 'POST', headers, body }))
        return { status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: await res.text() }
      })
    } finally {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }
  },
})
