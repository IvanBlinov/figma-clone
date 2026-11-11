/**
 * MCP server for the Figma clone. Talks to the Convex backend over HTTP, so every change an agent makes shows up
 * live in any open editor. Runs in three places: over stdio or as a standalone HTTP server (cli.ts), and inside the
 * Convex deployment itself as the hosted endpoint <deployment>.convex.site/mcp (convex/mcpNode.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Resvg } from '@resvg/resvg-js'
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { currentToken, forgetToken, requestToken, startLogin } from './auth'
import { fontOptions } from './fonts'
import { registerParity } from './parity'
import {
  ancestors,
  applyOpsToList,
  buildIndex,
  cloneSubtrees,
  descendants,
  kids,
  parentOf,
  ROOT,
  sortByDocOrder,
  topLevelOnly,
  worldMatrix,
  type DocIndex,
} from '../shared/doc'
import { boundsOf, corners, decompose, invert, mul, translate, type Mat } from '../shared/geometry'
import { cssText } from '../shared/css'
import { runLayout } from '../shared/layout'
import { resolveOps } from '../shared/resolve'
import { exportSvg } from '../shared/svg'
import { estimateMeasure } from '../shared/text'
import { defaultsFor, newId, typeLabel, type NodeType, type Op, type Paint, type SceneNode } from '../shared/types'

// ---------- config ----------
const here = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
})()
function envFile(): Record<string, string> {
  for (const p of [resolve(here, '../../.env.local'), resolve(here, '../.env.local'), resolve(process.cwd(), '.env.local')]) {
    if (!existsSync(p)) continue
    const out: Record<string, string> = {}
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2]
    }
    return out
  }
  return {}
}
const env = envFile()
// Inside the Convex deployment (hosted endpoint) its own URLs come from the built-in environment.
const CONVEX_URL = process.env.FIGMA_CLONE_CONVEX_URL || process.env.CONVEX_CLOUD_URL || env.VITE_CONVEX_URL || 'http://127.0.0.1:3210'
const APP_URL = (process.env.FIGMA_CLONE_APP_URL || (process.env.CONVEX_CLOUD_URL && process.env.SITE_URL) || 'http://localhost:5173').replace(/\/$/, '')
const AGENT_NAME = process.env.FIGMA_CLONE_AGENT_NAME || 'Claude'
const SESSION = 'agent-' + newId()

// HTTP endpoints of the deployment (OAuth). Convex cloud serves them on *.convex.site; a local backend on the next port.
const SITE_URL = (
  process.env.FIGMA_CLONE_SITE_URL ||
  process.env.CONVEX_SITE_URL ||
  (process.env.FIGMA_CLONE_CONVEX_URL ? '' : env.VITE_CONVEX_SITE_URL) ||
  (CONVEX_URL.includes('.convex.cloud') ? CONVEX_URL.replace('.convex.cloud', '.convex.site') : CONVEX_URL.replace(/:(\d+)$/, (_m, p) => ':' + (+p + 1)))
).replace(/\/$/, '')

const client = new ConvexHttpClient(CONVEX_URL)
/** Every call carries the caller's access token (see auth.ts), which the backend maps to a user. */
const withToken = (args: Record<string, unknown>) => {
  const t = currentToken(CONVEX_URL)
  return t ? { ...args, token: t.token } : args
}
const convex = {
  query: (fn: unknown, args: Record<string, unknown>) => client.query(fn as never, withToken(args) as never) as Promise<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  mutation: (fn: unknown, args: Record<string, unknown>) => client.mutation(fn as never, withToken(args) as never) as Promise<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
}
const api = anyApi
const fileUrl = (fileId: string) => `${APP_URL}/#/file/${fileId}`

// ---------- helpers ----------
const NODE_TYPES = ['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'VECTOR', 'TEXT'] as const
const r2 = (v: number) => Math.round(v * 100) / 100

interface PageCtx {
  fileId: string
  pageId: string
  nodes: SceneNode[]
  ix: DocIndex
}

async function resolvePage(fileId: string, pageId?: string): Promise<string> {
  if (pageId) return pageId
  const pages = (await convex.query(api.pages.list, { fileId })) as { _id: string }[]
  if (!pages.length) throw new Error(`File ${fileId} has no pages (does it exist? use list_files)`)
  return pages[0]._id
}

async function loadPage(fileId: string, pageId?: string): Promise<PageCtx> {
  const pid = await resolvePage(fileId, pageId)
  const stored = (await convex.query(api.nodes.list, { pageId: pid })) as SceneNode[]
  const { nodes, index } = runLayout(stored, estimateMeasure)
  return { fileId, pageId: pid, nodes, ix: index }
}

/** Find which page the given nodes live on. */
async function pageOfNodes(fileId: string, ids: string[]): Promise<PageCtx> {
  if (!ids.length) throw new Error('No node ids given')
  const found = (await convex.query(api.nodes.get, { fileId, ids })) as { pageId: string; node: SceneNode }[]
  const missing = ids.filter((id) => !found.some((f) => f.node.id === id))
  if (missing.length) throw new Error(`Node(s) not found in file: ${missing.join(', ')}`)
  const pagesHit = new Set(found.map((f) => f.pageId))
  if (pagesHit.size > 1) throw new Error('Nodes are on different pages; operate on one page at a time')
  return loadPage(fileId, found[0].pageId)
}

/** Apply ops, fold in derived layout (auto layout, hug, text size, group bounds) and announce agent presence. */
async function write(ctx: PageCtx, ops: Op[], touched: string[] = []): Promise<DocIndex> {
  const stored = (await convex.query(api.nodes.list, { pageId: ctx.pageId })) as SceneNode[]
  // Fold in everything the edit implies: auto layout, constraints, instance sync, override bookkeeping.
  const resolved = resolveOps(stored, ops, estimateMeasure)
  await convex.mutation(api.nodes.applyOps, { fileId: ctx.fileId, pageId: ctx.pageId, ops: resolved.ops })
  const layout = { index: buildIndex(resolved.nodes) }
  const live = touched.filter((id) => layout.index.byId.has(id))
  try {
    let x = 0
    let y = 0
    if (live.length) {
      const n = layout.index.byId.get(live[0])!
      const b = boundsOf(corners(worldMatrix(layout.index, n.id), n.width, n.height))
      x = b.x + b.w
      y = b.y + b.h
    }
    await convex.mutation(api.presence.update, {
      fileId: ctx.fileId,
      sessionId: SESSION,
      name: AGENT_NAME,
      color: '#D97757',
      pageId: ctx.pageId,
      x,
      y,
      selection: live.slice(0, 50),
      isAgent: true,
    })
  } catch {
    /* presence is best-effort */
  }
  return layout.index
}

function normalizePaints(v: unknown, what: string): Paint[] | undefined {
  if (v === undefined) return undefined
  if (v === null) return []
  if (typeof v === 'string') return [{ type: 'SOLID', color: hex(v) }]
  if (!Array.isArray(v)) throw new Error(`${what} must be an array of paints or a hex color string`)
  return v.map((p) => {
    if (typeof p === 'string') return { type: 'SOLID', color: hex(p) } as Paint
    if (p?.type === 'SOLID') return { ...p, color: hex(p.color) }
    if (p?.type === 'GRADIENT_LINEAR' || p?.type === 'GRADIENT_RADIAL') {
      if (!Array.isArray(p.stops) || p.stops.length < 2) throw new Error('Gradient paints need at least 2 stops: [{position, color, opacity?}]')
      return { ...p, stops: p.stops.map((s: { position: number; color: string; opacity?: number }) => ({ ...s, color: hex(s.color) })) }
    }
    if (p?.type === 'IMAGE') {
      if (typeof p.url !== 'string') throw new Error('IMAGE paints need a url')
      return p
    }
    throw new Error(`Unknown paint type in ${what}: ${JSON.stringify(p)}`)
  })
}

function hex(c: string): string {
  let h = String(c).trim().replace('#', '')
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((x) => x + x).join('')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`Invalid color "${c}" — use #RRGGBB`)
  return '#' + h.toUpperCase()
}

/** Turn agent-supplied props into stored props (shorthands, validation). */
function normalizeProps(input: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...input }
  delete p.children
  delete p.id
  if ('fill' in p) {
    p.fills = normalizePaints(p.fill, 'fill')
    delete p.fill
  } else if ('fills' in p) p.fills = normalizePaints(p.fills, 'fills')
  if ('stroke' in p) {
    p.strokes = normalizePaints(p.stroke, 'stroke')
    delete p.stroke
  } else if ('strokes' in p) p.strokes = normalizePaints(p.strokes, 'strokes')
  if (typeof p.padding === 'number') {
    p.paddingLeft = p.paddingRight = p.paddingTop = p.paddingBottom = p.padding
    delete p.padding
  }
  if (Array.isArray(p.effects))
    p.effects = p.effects.map((e: Record<string, unknown>) => ('color' in e ? { ...e, color: hex(e.color as string) } : e))
  return p
}

function buildNodes(specs: unknown[], parentId: string | undefined, startOrder: number, parentIsAutoLayout: boolean, out: SceneNode[]): string[] {
  const ids: string[] = []
  specs.forEach((raw, i) => {
    const spec = raw as Record<string, unknown>
    const type = String(spec?.type ?? '').toUpperCase() as NodeType
    if (!NODE_TYPES.includes(type)) throw new Error(`Invalid node type "${spec?.type}". Use one of: ${NODE_TYPES.join(', ')}`)
    const props = normalizeProps(spec)
    const node = {
      id: newId(),
      order: startOrder + i,
      name: type === 'TEXT' && typeof props.characters === 'string' && props.characters ? props.characters.split('\n')[0].slice(0, 40) : typeLabel(type),
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      ...defaultsFor(type),
      ...props,
      type,
    } as SceneNode
    if (parentId) node.parentId = parentId
    if (type === 'TEXT') {
      if (props.textAutoResize === undefined && props.width !== undefined) node.textAutoResize = 'HEIGHT'
      if (parentIsAutoLayout && props.layoutSizingHorizontal === 'FILL' && props.textAutoResize === undefined) node.textAutoResize = 'HEIGHT'
    }
    if (type === 'LINE') node.height = 0
    if (type === 'VECTOR') {
      if (!node.vectorPath) throw new Error('VECTOR nodes need vectorPath (SVG path data)')
      node.vectorWidth ??= node.width
      node.vectorHeight ??= node.height
      if (props.fills === undefined && props.strokes === undefined) {
        node.fills = [{ type: 'SOLID', color: '#000000' }]
        node.strokes = []
      }
    }
    const isAL = type === 'FRAME' && !!node.layoutMode && node.layoutMode !== 'NONE'
    if (isAL) {
      if (props.layoutSizingHorizontal === undefined) node.layoutSizingHorizontal = props.width === undefined ? 'HUG' : 'FIXED'
      if (props.layoutSizingVertical === undefined) node.layoutSizingVertical = props.height === undefined ? 'HUG' : 'FIXED'
    }
    out.push(node)
    ids.push(node.id)
    const children = spec.children
    if (children !== undefined) {
      if (!Array.isArray(children)) throw new Error('children must be an array of node specs')
      if (type !== 'FRAME' && type !== 'GROUP') throw new Error(`${type} nodes cannot have children — only FRAME and GROUP can`)
      buildNodes(children, node.id, 0, isAL, out)
    }
  })
  return ids
}

function outline(ix: DocIndex, id: string, depth: number): Record<string, unknown> {
  const n = ix.byId.get(id)!
  const o: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, x: r2(n.x), y: r2(n.y), width: r2(n.width), height: r2(n.height) }
  if (n.rotation) o.rotation = n.rotation
  if (n.visible === false) o.visible = false
  if (n.locked) o.locked = true
  if (n.type === 'TEXT') o.characters = n.characters
  if (n.layoutMode && n.layoutMode !== 'NONE') o.layoutMode = n.layoutMode
  if (n.isComponent) o.isComponent = true
  if (n.isComponentSet) o.isComponentSet = true
  if (n.componentId) o.componentId = n.componentId
  if (n.sourceId) o.sourceId = n.sourceId
  if (n.overrides?.length) o.overrides = n.overrides
  if (n.booleanOp) o.booleanOp = n.booleanOp
  if (n.isMask) o.isMask = true
  if (n.reactions?.length) o.reactions = n.reactions
  if (n.flowStart) o.flowStart = n.flowStart
  const c = kids(ix, id)
  if (c.length) {
    if (depth > 0) o.children = c.map((k) => outline(ix, k, depth - 1))
    else o.childCount = c.length
  }
  return o
}

function full(ix: DocIndex, id: string): Record<string, unknown> {
  const n = ix.byId.get(id)!
  const m = worldMatrix(ix, id)
  const b = boundsOf(corners(m, n.width, n.height))
  return { ...n, absoluteBoundingBox: { x: r2(b.x), y: r2(b.y), width: r2(b.w), height: r2(b.h) }, childIds: kids(ix, id) }
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] })

const registrations: { name: string; description: string; shape: z.ZodRawShape; run: (args: never) => Promise<unknown> }[] = []

/** Declare a tool. Tools are registered on every server instance (one for stdio, one per request over HTTP). */
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: unknown[] }>) {
  registrations.push({
    name,
    description,
    shape,
    run: async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return await handler(args)
      } catch (e) {
        const data = (e as { data?: unknown }).data
        const msg = typeof data === 'string' ? data : e instanceof Error ? e.message : String(e)
        let hint = ''
        if (/fetch failed|ECONNREFUSED/i.test(msg)) hint = ` — is the Convex backend reachable at ${CONVEX_URL}?`
        else if (/Not signed in|Invalid, expired or revoked/i.test(msg))
          hint = currentToken(CONVEX_URL)
            ? ' — the saved access token is no longer valid. Call the login tool to sign in again, or set FIGMA_CLONE_TOKEN to a new API token.'
            : ' — call the login tool to sign in through the browser, or set FIGMA_CLONE_TOKEN to an API token created in the app (Account → API tokens).'
        return { content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }], isError: true }
      }
    },
  })
}

// ---------- server ----------
const NODE_GUIDE = `Node model (all coordinates are px, relative to the parent's top-left; rotation in degrees clockwise):
- type: FRAME | GROUP | RECTANGLE | ELLIPSE | LINE | POLYGON | STAR | VECTOR | TEXT. Only FRAME and GROUP take children.
- Common: name, x, y, width, height, rotation, opacity (0..1), visible, locked, blendMode.
- fills / strokes: arrays of paints. Paint = {type:"SOLID", color:"#RRGGBB", opacity?} | {type:"GRADIENT_LINEAR"|"GRADIENT_RADIAL", stops:[{position:0..1,color,opacity?}], angle?} (angle 0 = left→right, 90 = top→bottom) | {type:"IMAGE", url, scaleMode?:"FILL"|"FIT"|"STRETCH"}.
  Shorthands: fill:"#RRGGBB" and stroke:"#RRGGBB". fills:[] removes the fill.
- strokeWeight, strokeAlign ("INSIDE"|"CENTER"|"OUTSIDE"), dashPattern [dash, gap], strokeCap.
- cornerRadius (or cornerRadii [tl,tr,br,bl]) for RECTANGLE and FRAME.
- effects: [{type:"DROP_SHADOW"|"INNER_SHADOW", color, opacity, x, y, blur, spread?} | {type:"LAYER_BLUR", radius}].
- FRAME: clipsContent (default true), and auto layout: layoutMode "HORIZONTAL"|"VERTICAL"|"NONE", itemSpacing, padding (all sides) or paddingLeft/Right/Top/Bottom, primaryAxisAlignItems "MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN", counterAxisAlignItems "MIN"|"CENTER"|"MAX".
  An auto-layout frame hugs its content on any axis where you omit width/height (layoutSizingHorizontal/Vertical: "FIXED"|"HUG"|"FILL").
  Children of auto-layout frames are positioned automatically (their x/y are ignored); give a child layoutSizingHorizontal/Vertical:"FILL" to stretch, or layoutPositioning:"ABSOLUTE" to opt out.
- TEXT: characters, fontSize, fontFamily (Google Fonts, default Inter), fontWeight (100..900), italic, textAlignHorizontal "LEFT"|"CENTER"|"RIGHT", textAlignVertical, lineHeight (px), letterSpacing (px), textDecoration, textCase.
  Text auto-sizes: omit width for a single line that grows (textAutoResize "WIDTH_AND_HEIGHT"); pass width to wrap inside it ("HEIGHT"). Text color is its fill.
- POLYGON: pointCount. STAR: pointCount, starInnerRadius (0..1). LINE: width is the length, use rotation for direction.
- VECTOR: vectorPath (SVG path data "M… L… C… Z") drawn in a vectorWidth × vectorHeight box (defaults to width × height) — use this for icons and custom shapes. vectorFillRule "nonzero"|"evenodd".
- Children arrays are ordered back → front (and first → last in auto layout).
- TEXT mixed styles: textRuns:[{start,end,style:{fontWeight?,fontSize?,fontFamily?,italic?,textDecoration?,letterSpacing?,fills?}}] overrides the node style for characters [start,end).
- LINE: arrowStart / arrowEnd (booleans) draw arrowheads.
- Constraints (children of a FRAME without auto layout): constraints:{horizontal,vertical} each "MIN"|"MAX"|"CENTER"|"STRETCH"|"SCALE" — how the child follows when the frame is resized. constrainProportions locks the aspect ratio.
- Auto layout extras: layoutWrap (horizontal only), counterAxisSpacing (row gap when wrapping), minWidth/maxWidth/minHeight/maxHeight.
- layoutGrids on frames: [{pattern:"GRID",size} | {pattern:"COLUMNS"|"ROWS",count,gutter,margin}] with color/opacity.
- Components: a FRAME with isComponent:true is a main component. Create instances with create_instance (never by hand). Instance layers mirror the component
  (each has sourceId = the component layer it copies); edits made to an instance layer with update_nodes become overrides and survive later changes to the
  component. Structure inside instances is owned by the component: deleting an instance layer hides it; add or remove layers on the main component instead.
  A FRAME with isComponentSet:true groups variants (components named like "State=Hover"); switch an instance's variant by updating its componentId.
- Boolean shapes: a GROUP with booleanOp "UNION"|"SUBTRACT"|"INTERSECT"|"EXCLUDE" renders its children combined (first child is the base) and takes fills/strokes itself — or use boolean_operation on existing nodes.
- Masks: isMask:true on a node clips all siblings stacked above it (later in the children array) to its outline.
- Prototype: reactions:[{trigger:"ON_CLICK"|"ON_HOVER"|"ON_PRESS"|"AFTER_TIMEOUT", action:"NAVIGATE"|"OVERLAY"|"CLOSE_OVERLAY"|"BACK"|"URL", destinationId? (a top-level FRAME), url?, transition?:"INSTANT"|"DISSOLVE"|"SMART_ANIMATE"|"MOVE_IN"|"PUSH"|"SLIDE_IN", direction?, duration? (ms), easing?, timeout? (ms)}] on any node; flowStart:"Flow 1" on a top-level frame marks a starting point. See add_interaction / get_prototype_url.
- Shared styles: fillStyleId / strokeStyleId / textStyleId link a node to a style from list_styles (use apply_style); editing the style updates every linked node.`

/**
 * Tools that only make sense when the server runs on the user's own machine. They are left out when it serves many
 * users over HTTP: login / logout manage a token file on disk, and use_figma runs caller-supplied JavaScript in
 * node:vm, which is not a security boundary.
 */
const LOCAL_ONLY = new Set(['login', 'logout', 'use_figma'])

/** A server instance. `shared` = serving several users over HTTP, each request carrying its own token. */
export const makeServer = (shared = false) => {
  const server = new McpServer({ name: 'figma-clone', version: '0.5.0' }, { instructions: shared ? INSTRUCTIONS_SHARED : INSTRUCTIONS })
  for (const r of registrations) if (!shared || !LOCAL_ONLY.has(r.name)) server.registerTool(r.name, { description: r.description, inputSchema: r.shape }, r.run as never)
  return server
}
export { requestToken }

const INSTRUCTIONS = `Design tool (Figma clone) backed by Convex. Projects group files (a file without a project is a draft). Files contain pages; pages contain a tree of nodes. Edits appear live in the browser editor at ${APP_URL}.
Typical flow: list_files / create_file → get_tree to inspect → create_nodes / update_nodes to design → export_image to look at the result and iterate.
Reusable UI: build a FRAME, turn it into a component (create_component), then place copies with create_instance and override text/fills per instance.
Clickable prototypes: connect layers to frames with add_interaction and hand the user get_prototype_url.
Figma-compatible tools are also available under the names of the official Figma MCP server (fileKey = file id): get_design_context, get_metadata, get_screenshot,
get_variable_defs, search_design_system, get_libraries, Code Connect (add_code_connect_map, get_code_connect_map, …), upload_assets, download_assets,
generate_diagram (Mermaid), create_new_file, whoami, and use_figma, which runs Figma Plugin API JavaScript — read get_figma_skill skill://figma/figma-use/SKILL.md first.
Never guess ids: take them from list_files, list_pages, get_tree, find_nodes or the results of create_nodes.
Access: you act as one user and see only the files they own or were invited to. If a tool reports "Not signed in", call login (opens a browser sign-in for the user) and retry.

${NODE_GUIDE}`
const INSTRUCTIONS_SHARED = INSTRUCTIONS.replace(/, and use_figma, which runs[^\n]*/, '.').replace(
  /Access: [^\n]*/,
  'Access: you act as the signed-in user and see only the files they own or were invited to. use_figma and local file paths are not available on this hosted endpoint; use create_nodes / update_nodes, and pass assets as url, base64 or svg.',
)

tool(
  'login',
  'Sign in through the browser so this server can act as the user (OAuth). Opens the sign-in page on the user\'s machine and waits for them to approve. Not needed when FIGMA_CLONE_TOKEN is set or a previous login is still valid — check with whoami first.',
  { wait: z.boolean().optional().describe('Wait up to two minutes for the user to finish (default true)') },
  async ({ wait }) => {
    const existing = currentToken(CONVEX_URL)
    if (existing) {
      try {
        const me = await convex.query(api.users.me as never, {})
        if (me) return ok({ signedIn: true, user: me, via: existing.source })
      } catch {
        if (existing.source === 'login') forgetToken(CONVEX_URL)
        else throw new Error('The access token in FIGMA_CLONE_TOKEN is invalid or revoked. Replace it with a new one from Account → API tokens.')
      }
    }
    const flow = await startLogin(CONVEX_URL, SITE_URL)
    const outcome = wait === false ? 'pending' : await Promise.race([flow.done.then(() => 'done' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 120_000))])
    if (outcome === 'done') return ok({ signedIn: true, user: await convex.query(api.users.me as never, {}), via: 'login' })
    return ok({ signedIn: false, message: 'Waiting for the user to approve in their browser. Ask them to open this URL, sign in and click Allow, then call whoami (the link is valid for five minutes).', url: flow.url })
  },
)

tool('logout', 'Forget the access token saved by login on this machine. (Revoke it for good in the app under Account → API tokens.)', {}, async () => {
  const removed = forgetToken(CONVEX_URL)
  return ok({ loggedOut: removed, note: process.env.FIGMA_CLONE_TOKEN ? 'FIGMA_CLONE_TOKEN is still set in the environment and will keep being used.' : undefined })
})

const fileId = z.string().describe('File id (from list_files or create_file)')
const pageIdOpt = z.string().optional().describe('Page id; defaults to the first page of the file')

tool(
  'list_files',
  'List the design files you own or that were shared with you, with ids, names, your role (owner / editor / viewer), project and editor URLs. Files without a project are drafts.',
  { projectId: z.string().optional().describe('Only files in this project'), draftsOnly: z.boolean().optional().describe('Only files that are not in any project') },
  async ({ projectId, draftsOnly }) => {
    const files = (await convex.query(api.files.list, {})) as { _id: string; name: string; updatedAt: number; projectId?: string; role: string; ownerName: string | null }[]
    const projects = (await convex.query(api.projects.list, {})) as { _id: string; name: string }[]
    return ok(
      files
        .filter((f) => (projectId ? f.projectId === projectId : draftsOnly ? !f.projectId : true))
        .map((f) => ({
          fileId: f._id,
          name: f.name,
          role: f.role,
          ...(f.ownerName ? { sharedBy: f.ownerName } : {}),
          project: f.projectId ? { projectId: f.projectId, name: projects.find((p) => p._id === f.projectId)?.name } : null,
          updatedAt: new Date(f.updatedAt).toISOString(),
          url: fileUrl(f._id),
        })),
    )
  },
)

tool(
  'create_file',
  'Create a new design file (with one empty page). Returns its id, first page id and editor URL.',
  { name: z.string().optional().describe('File name'), projectId: z.string().optional().describe('Project to create the file in; omit for a draft') },
  async ({ name, projectId }) => {
    const res = (await convex.mutation(api.files.create, { name, ...(projectId ? { projectId } : {}) })) as { fileId: string; pageId: string }
    return ok({ ...res, url: fileUrl(res.fileId) })
  },
)

tool('list_projects', 'List projects (folders of files) with how many files each holds.', {}, async () => {
  const rows = (await convex.query(api.projects.list, {})) as { _id: string; name: string; fileCount: number }[]
  return ok(rows.map((p) => ({ projectId: p._id, name: p.name, files: p.fileCount })))
})

tool('create_project', 'Create a project to group files.', { name: z.string() }, async ({ name }) => ok({ projectId: await convex.mutation(api.projects.create, { name }) }))

tool('rename_project', 'Rename a project.', { projectId: z.string(), name: z.string() }, async (a) => {
  await convex.mutation(api.projects.rename, a)
  return ok({ renamed: true })
})

tool('delete_project', 'Delete a project. Its files are kept and become drafts.', { projectId: z.string() }, async ({ projectId }) => {
  await convex.mutation(api.projects.remove, { projectId })
  return ok({ deleted: true })
})

tool(
  'move_file',
  'Move a file into a project, or back to drafts.',
  { fileId, projectId: z.string().nullable().describe('Target project id, or null for drafts') },
  async ({ fileId, projectId }) => {
    await convex.mutation(api.files.setProject, { fileId, projectId })
    return ok({ fileId, projectId })
  },
)

tool('rename_file', 'Rename a design file.', { fileId, name: z.string() }, async (a) => {
  await convex.mutation(api.files.rename, a)
  return ok({ renamed: true })
})

tool('get_sharing', 'Who has access to a file: its owner, the people it is shared with (and their role), whether anyone with the link can view it, and your own role.', { fileId }, async ({ fileId }) => {
  const info = await convex.query(api.sharing.get, { fileId })
  if (!info) throw new Error('File not found, or you do not have access to it')
  return ok({ yourRole: info.role, owner: info.owner, people: info.people.map((p: { _id: string; email: string; role: string; joined: boolean }) => ({ shareId: p._id, email: p.email, role: p.role, hasAccount: p.joined })), linkAccess: info.linkAccess, url: fileUrl(fileId) })
})

tool(
  'share_file',
  'Share a file you own with someone by email as "editor" or "viewer" (also changes the role of someone already invited). They see it under "Shared with me" once they sign in with that email. Only do this when the user asked for it.',
  { fileId, email: z.string(), role: z.enum(['editor', 'viewer']) },
  async ({ fileId, email, role }) => {
    await convex.mutation(api.sharing.invite, { fileId, email, role })
    return ok({ shared: true, email: email.trim().toLowerCase(), role, url: fileUrl(fileId) })
  },
)

tool('unshare_file', 'Remove someone\'s access to a file you own.', { fileId, email: z.string() }, async ({ fileId, email }) => {
  const info = await convex.query(api.sharing.get, { fileId })
  const hit = info?.people.find((p: { email: string }) => p.email === email.trim().toLowerCase())
  if (!hit) throw new Error(`${email} does not have access to this file`)
  await convex.mutation(api.sharing.remove, { shareId: hit._id })
  return ok({ removed: true })
})

tool(
  'set_link_access',
  'Choose whether anyone with the link can view a file you own ("view", no account needed) or only invited people can open it ("none"). Only do this when the user asked for it.',
  { fileId, linkAccess: z.enum(['none', 'view']) },
  async ({ fileId, linkAccess }) => {
    await convex.mutation(api.sharing.setLinkAccess, { fileId, linkAccess })
    return ok({ linkAccess, url: fileUrl(fileId) })
  },
)

tool('list_pages', 'List the pages of a file.', { fileId }, async ({ fileId }) => {
  const pages = (await convex.query(api.pages.list, { fileId })) as { _id: string; name: string; background?: string }[]
  return ok(pages.map((p) => ({ pageId: p._id, name: p.name, background: p.background ?? '#F5F5F5' })))
})

tool('create_page', 'Add a page to a file.', { fileId, name: z.string().optional() }, async (a) => ok({ pageId: await convex.mutation(api.pages.create, a) }))

tool(
  'update_page',
  'Rename a page and/or change its canvas background color.',
  { pageId: z.string(), name: z.string().optional(), background: z.string().optional().describe('#RRGGBB') },
  async ({ pageId, name, background }) => {
    await convex.mutation(api.pages.update, { pageId, name, background: background ? hex(background) : undefined })
    return ok({ updated: true })
  },
)

tool('delete_page', 'Delete a page and all nodes on it. A file always keeps at least one page.', { pageId: z.string() }, async ({ pageId }) => {
  await convex.mutation(api.pages.remove, { pageId })
  return ok({ deleted: true })
})

tool(
  'get_tree',
  'Get the layer tree of a page (or of one node) as a compact outline: id, type, name, geometry, text content, children. Use get_nodes for full properties.',
  {
    fileId,
    pageId: pageIdOpt,
    nodeId: z.string().optional().describe('Only return the subtree under this node'),
    depth: z.number().int().min(0).max(50).optional().describe('How many levels of children to include (default 4)'),
  },
  async ({ fileId, pageId, nodeId, depth }) => {
    const ctx = nodeId ? await pageOfNodes(fileId, [nodeId]) : await loadPage(fileId, pageId)
    const d = depth ?? 4
    const roots = nodeId ? [nodeId] : kids(ctx.ix, ROOT)
    return ok({ pageId: ctx.pageId, nodes: roots.map((id) => outline(ctx.ix, id, d)) })
  },
)

tool(
  'get_nodes',
  'Get every property of specific nodes, plus their absolute bounding box on the page and child ids.',
  { fileId, ids: z.array(z.string()).min(1) },
  async ({ fileId, ids }) => {
    const ctx = await pageOfNodes(fileId, ids)
    return ok(ids.map((id) => full(ctx.ix, id)))
  },
)

tool(
  'find_nodes',
  'Search a page for nodes by name, type and/or text content (case-insensitive substring match).',
  {
    fileId,
    pageId: pageIdOpt,
    name: z.string().optional(),
    type: z.enum(NODE_TYPES).optional(),
    text: z.string().optional().describe('Match against the characters of TEXT nodes'),
  },
  async ({ fileId, pageId, name, type, text }) => {
    const ctx = await loadPage(fileId, pageId)
    const hits = ctx.nodes.filter(
      (n) =>
        (!type || n.type === type) &&
        (!name || n.name.toLowerCase().includes(name.toLowerCase())) &&
        (!text || (n.type === 'TEXT' && (n.characters ?? '').toLowerCase().includes(text.toLowerCase()))),
    )
    return ok(
      hits.slice(0, 200).map((n) => ({
        ...outline(ctx.ix, n.id, 0),
        path: [...ancestors(ctx.ix, n.id)].reverse().map((a) => ctx.ix.byId.get(a)!.name).join(' / '),
      })),
    )
  },
)

tool(
  'create_nodes',
  `Create one or more nodes (with nested children) on a page. Returns the created tree with ids.\n${NODE_GUIDE}\nTop-level nodes created without x/y are placed to the right of existing content so they never overlap.`,
  {
    fileId,
    pageId: pageIdOpt,
    parentId: z.string().optional().describe('FRAME or GROUP to create inside; omit to create at page level'),
    index: z.number().int().min(0).optional().describe('Position among the parent\'s children (0 = back/first). Default: on top / last'),
    nodes: z.array(z.record(z.string(), z.any())).min(1).describe('Node specs: {type, name?, x?, y?, width?, height?, ...props, children?: [...]}'),
  },
  async ({ fileId, pageId, parentId, index, nodes }) => {
    const ctx = parentId ? await pageOfNodes(fileId, [parentId]) : await loadPage(fileId, pageId)
    const parent = parentId ? ctx.ix.byId.get(parentId)! : undefined
    if (parent && parent.type !== 'FRAME' && parent.type !== 'GROUP') throw new Error(`Parent ${parentId} is a ${parent.type}; only FRAME or GROUP can contain nodes`)
    const siblings = kids(ctx.ix, parentId ?? ROOT)
    const created: SceneNode[] = []
    const parentAL = !!parent && parent.type === 'FRAME' && !!parent.layoutMode && parent.layoutMode !== 'NONE'
    const rootIds = buildNodes(nodes, parentId, 0, parentAL, created)
    // Auto-place page-level nodes that have no explicit position.
    if (!parentId) {
      let right = siblings.length ? Math.max(...siblings.map((id) => {
        const n = ctx.ix.byId.get(id)!
        const b = boundsOf(corners(worldMatrix(ctx.ix, id), n.width, n.height))
        return b.x + b.w
      })) + 100 : 0
      const top = siblings.length ? Math.min(...siblings.map((id) => ctx.ix.byId.get(id)!.y)) : 0
      rootIds.forEach((id, i) => {
        const n = created.find((c) => c.id === id)!
        const spec = nodes[i] as Record<string, unknown>
        if (spec.x === undefined && spec.y === undefined) {
          n.x = right
          n.y = top
          // Width may be unknown until layout for hug frames; estimate with a quick layout pass.
          const laid = runLayout(created.filter((c) => c.id === id || descendantOf(created, c, id)), estimateMeasure)
          right += (laid.index.byId.get(id)?.width ?? n.width) + 100
        }
      })
    }
    const at = index === undefined ? siblings.length : Math.min(index, siblings.length)
    const ordered = [...siblings.slice(0, at), ...rootIds, ...siblings.slice(at)]
    const ops: Op[] = []
    ordered.forEach((id, i) => {
      const fresh = created.find((c) => c.id === id)
      if (fresh) fresh.order = i
      else if (ctx.ix.byId.get(id)!.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
    })
    const ix = await write(ctx, [...created.map((n) => ({ op: 'create' as const, node: n })), ...ops], rootIds)
    return ok({ pageId: ctx.pageId, created: rootIds.map((id) => outline(ix, id, 20)) })
  },
)

function descendantOf(list: SceneNode[], n: SceneNode, rootId: string): boolean {
  let p = n.parentId
  let guard = 0
  while (p && guard++ < 1000) {
    if (p === rootId) return true
    p = list.find((c) => c.id === p)?.parentId
  }
  return false
}

tool(
  'update_nodes',
  `Change properties of existing nodes. Each update is {id, ...props}; only the given props change, and a null value clears a prop.\n${NODE_GUIDE}`,
  { fileId, updates: z.array(z.record(z.string(), z.any())).min(1).describe('[{id, ...propsToChange}]') },
  async ({ fileId, updates }) => {
    const ids = updates.map((u) => String(u.id))
    const ctx = await pageOfNodes(fileId, ids)
    const ops: Op[] = updates.map((u) => {
      const n = ctx.ix.byId.get(String(u.id))!
      const patch = normalizeProps(u)
      if ('type' in patch) throw new Error('Node type cannot be changed; create a new node instead')
      if ('parentId' in patch || 'order' in patch) throw new Error('Use move_nodes to change parent or stacking order')
      if (patch.width != null && patch.layoutSizingHorizontal === undefined && n.layoutSizingHorizontal && n.layoutSizingHorizontal !== 'FIXED') patch.layoutSizingHorizontal = 'FIXED'
      if (patch.height != null && patch.layoutSizingVertical === undefined && n.layoutSizingVertical && n.layoutSizingVertical !== 'FIXED') patch.layoutSizingVertical = 'FIXED'
      if (n.type === 'TEXT' && patch.textAutoResize === undefined) {
        if (patch.height != null) patch.textAutoResize = 'NONE'
        else if (patch.width != null && (n.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT') patch.textAutoResize = 'HEIGHT'
      }
      if (n.type === 'TEXT' && typeof patch.characters === 'string' && patch.name === undefined && (n.name === 'Text' || n.name === (n.characters ?? '').split('\n')[0].slice(0, 40)))
        patch.name = patch.characters.split('\n')[0].slice(0, 40) || 'Text'
      return { op: 'update', id: n.id, patch }
    })
    const ix = await write(ctx, ops, ids)
    return ok({ updated: ids.map((id) => outline(ix, id, 0)) })
  },
)

tool('delete_nodes', 'Delete nodes and everything inside them.', { fileId, ids: z.array(z.string()).min(1) }, async ({ fileId, ids }) => {
  const ctx = await pageOfNodes(fileId, ids)
  const gone = new Set<string>()
  for (const id of topLevelOnly(ctx.ix, ids)) {
    gone.add(id)
    for (const d of descendants(ctx.ix, id)) gone.add(d)
  }
  await write(ctx, [...gone].map((id) => ({ op: 'delete' as const, id })))
  return ok({ deleted: gone.size })
})

tool(
  'move_nodes',
  'Move nodes to another parent and/or change their stacking order. Nodes keep their position on the canvas (unless the new parent uses auto layout).',
  {
    fileId,
    ids: z.array(z.string()).min(1),
    parentId: z.string().nullable().optional().describe('New parent FRAME/GROUP id, null for page level. Omit to keep the current parent of the first node'),
    index: z.number().int().min(0).optional().describe('Position among siblings (0 = back/first). Default: front/last'),
  },
  async ({ fileId, ids, parentId, index }) => {
    const ctx = await pageOfNodes(fileId, parentId ? [...ids, parentId] : ids)
    const { ix } = ctx
    const target = parentId === undefined ? parentOf(ix, ids[0]) : (parentId ?? ROOT)
    if (target !== ROOT) {
      const t = ix.byId.get(target)!
      if (t.type !== 'FRAME' && t.type !== 'GROUP') throw new Error('Target parent must be a FRAME or GROUP')
      if (ids.includes(target) || ancestors(ix, target).some((a) => ids.includes(a))) throw new Error('Cannot move a node into itself or its own descendant')
    }
    const moving = sortByDocOrder(ix, topLevelOnly(ix, ids))
    const tm: Mat = target === ROOT ? [1, 0, 0, 1, 0, 0] : worldMatrix(ix, target)
    const ops: Op[] = []
    for (const id of moving) {
      if (parentOf(ix, id) === target) continue
      const d = decompose(mul(invert(tm), worldMatrix(ix, id)))
      ops.push({ op: 'update', id, patch: { parentId: target === ROOT ? null : target, x: r2(d.x), y: r2(d.y), rotation: d.rotation || null } })
    }
    const rest = kids(ix, target).filter((k) => !moving.includes(k))
    const at = index === undefined ? rest.length : Math.min(index, rest.length)
    ;[...rest.slice(0, at), ...moving, ...rest.slice(at)].forEach((id, i) => {
      if (ix.byId.get(id)!.order !== i || moving.includes(id)) ops.push({ op: 'update', id, patch: { order: i } })
    })
    const next = await write(ctx, ops, moving)
    return ok({ moved: moving.map((id) => outline(next, id, 0)) })
  },
)

tool(
  'duplicate_nodes',
  'Duplicate nodes (with children). The copies are placed right above the originals, optionally offset.',
  { fileId, ids: z.array(z.string()).min(1), offsetX: z.number().optional(), offsetY: z.number().optional() },
  async ({ fileId, ids, offsetX, offsetY }) => {
    const ctx = await pageOfNodes(fileId, ids)
    const roots = topLevelOnly(ctx.ix, ids)
    const { nodes, idMap } = cloneSubtrees(ctx.ix, roots)
    for (const r of roots) if (ctx.ix.byId.get(r)!.isComponent) toInstance(ctx.ix, nodes, idMap, r)
    const ops: Op[] = []
    for (const p of new Set(roots.map((id) => parentOf(ctx.ix, id)))) {
      const ordered: string[] = []
      for (const k of kids(ctx.ix, p)) {
        ordered.push(k)
        if (roots.includes(k)) ordered.push(idMap.get(k)!)
      }
      ordered.forEach((id, i) => {
        const fresh = nodes.find((n) => n.id === id)
        if (fresh) {
          fresh.order = i
          fresh.x += offsetX ?? 0
          fresh.y += offsetY ?? 0
        } else if (ctx.ix.byId.get(id)!.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
      })
    }
    const newRoots = roots.map((id) => idMap.get(id)!)
    const ix = await write(ctx, [...nodes.map((n) => ({ op: 'create' as const, node: n })), ...ops], newRoots)
    return ok({ created: newRoots.map((id) => outline(ix, id, 20)) })
  },
)

/** Wrap nodes in a new GROUP / FRAME, keeping their place on the canvas. Returns the wrapper id and the resulting index. */
async function wrapNodes(ctx: PageCtx, ids: string[], type: NodeType, name: string, props: Record<string, unknown>): Promise<{ id: string; ix: DocIndex }> {
  const { ix } = ctx
  const list = sortByDocOrder(ix, topLevelOnly(ix, ids))
  const front = list[list.length - 1]
  const parent = parentOf(ix, front)
  const pm: Mat = parent === ROOT ? [1, 0, 0, 1, 0, 0] : worldMatrix(ix, parent)
  const rel = new Map(list.map((id) => [id, mul(invert(pm), worldMatrix(ix, id))]))
  const b = boundsOf(list.flatMap((id) => corners(rel.get(id)!, ix.byId.get(id)!.width, ix.byId.get(id)!.height)))
  const wrapper = {
    id: newId(),
    order: 0,
    type,
    name,
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    ...(type === 'FRAME' ? { fills: [], clipsContent: false } : {}),
    ...normalizeProps(props),
  } as SceneNode
  if (parent !== ROOT) wrapper.parentId = parent
  const ops: Op[] = [{ op: 'create', node: wrapper }]
  list.forEach((id, i) => {
    const d = decompose(mul(translate(-b.x, -b.y), rel.get(id)!))
    ops.push({ op: 'update', id, patch: { parentId: wrapper.id, x: d.x, y: d.y, rotation: d.rotation || null, order: i } })
  })
  kids(ix, parent)
    .flatMap((k) => (k === front ? [wrapper.id] : list.includes(k) ? [] : [k]))
    .forEach((id, i) => {
      if (id === wrapper.id) wrapper.order = i
      else if (ix.byId.get(id)!.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
    })
  return { id: wrapper.id, ix: await write(ctx, ops, [wrapper.id]) }
}

/** Turn the clone of a main component into an instance of it (mutates the clones). */
function toInstance(ix: DocIndex, clones: SceneNode[], idMap: Map<string, string>, mainId: string) {
  const byId = new Map(clones.map((c) => [c.id, c]))
  const root = byId.get(idMap.get(mainId)!)!
  delete root.isComponent
  delete root.description
  delete root.flowStart
  root.componentId = mainId
  for (const d of descendants(ix, mainId)) {
    const c = byId.get(idMap.get(d)!)
    if (!c) continue
    c.sourceId = d
    delete c.overrides
  }
}

tool(
  'group_nodes',
  'Wrap nodes in a new GROUP (or FRAME). Nodes keep their position on the canvas.',
  {
    fileId,
    ids: z.array(z.string()).min(1),
    name: z.string().optional(),
    asFrame: z.boolean().optional().describe('Create a FRAME instead of a GROUP'),
    props: z.record(z.string(), z.any()).optional().describe('Extra properties for the wrapper (e.g. auto layout settings for a frame)'),
  },
  async ({ fileId, ids, name, asFrame, props }) => {
    const ctx = await pageOfNodes(fileId, ids)
    const type: NodeType = asFrame ? 'FRAME' : 'GROUP'
    const res = await wrapNodes(ctx, ids, type, name ?? typeLabel(type), props ?? {})
    return ok({ created: outline(res.ix, res.id, 2) })
  },
)

tool(
  'boolean_operation',
  'Combine shapes into one boolean shape (non-destructive: the operands stay editable inside it). The bottom-most node is the base — SUBTRACT removes the others from it.',
  { fileId, ids: z.array(z.string()).min(1), operation: z.enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE']), name: z.string().optional(), props: z.record(z.string(), z.any()).optional().describe('fills / strokes etc. for the result (default: the base node\'s)') },
  async ({ fileId, ids, operation, name, props }) => {
    const ctx = await pageOfNodes(fileId, ids)
    const base = ctx.ix.byId.get(sortByDocOrder(ctx.ix, topLevelOnly(ctx.ix, ids))[0])!
    const label = operation[0] + operation.slice(1).toLowerCase()
    const res = await wrapNodes(ctx, ids, 'GROUP', name ?? label, {
      booleanOp: operation,
      fills: base.fills?.length && base.type !== 'LINE' ? base.fills : [{ type: 'SOLID', color: '#D9D9D9' }],
      ...(base.strokes?.length ? { strokes: base.strokes, strokeWeight: base.strokeWeight ?? 1, strokeAlign: 'CENTER' } : {}),
      ...(props ?? {}),
    })
    return ok({ created: outline(res.ix, res.id, 2) })
  },
)

// ---------- components ----------
tool('list_components', 'List the main components on a page (with how many instances each has). Component sets list their variants.', { fileId, pageId: pageIdOpt }, async ({ fileId, pageId }) => {
  const ctx = await loadPage(fileId, pageId)
  return ok(
    ctx.nodes
      .filter((n) => n.isComponent)
      .map((n) => {
        const set = n.parentId ? ctx.ix.byId.get(n.parentId) : undefined
        return {
          componentId: n.id,
          name: n.name,
          ...(set?.isComponentSet ? { componentSet: { id: set.id, name: set.name } } : {}),
          width: r2(n.width),
          height: r2(n.height),
          instances: ctx.nodes.filter((x) => x.componentId === n.id && !x.sourceId).length,
          layers: descendants(ctx.ix, n.id).map((id) => ({ id, name: ctx.ix.byId.get(id)!.name, type: ctx.ix.byId.get(id)!.type })),
        }
      }),
  )
})

tool(
  'create_component',
  'Turn FRAME nodes into main components (reusable; place copies with create_instance). To build a component from loose layers, wrap them first with group_nodes(asFrame: true). Pass several ids with combineAsVariants to also wrap them in a component set.',
  { fileId, ids: z.array(z.string()).min(1), combineAsVariants: z.boolean().optional().describe('Also wrap the components in a component set (variants)'), setName: z.string().optional() },
  async ({ fileId, ids, combineAsVariants, setName }) => {
    const ctx = await pageOfNodes(fileId, ids)
    const ops: Op[] = []
    for (const id of ids) {
      const n = ctx.ix.byId.get(id)!
      if (n.type !== 'FRAME') throw new Error(`${id} is a ${n.type}; only FRAME nodes can become components`)
      if (n.componentId || n.sourceId) throw new Error(`${id} is (part of) an instance; detach it first`)
      if (!n.isComponent) ops.push({ op: 'update', id, patch: { isComponent: true } })
    }
    const ix = ops.length ? await write(ctx, ops, ids) : ctx.ix
    if (combineAsVariants) {
      const fresh = await pageOfNodes(fileId, ids)
      const res = await wrapNodes(fresh, ids, 'FRAME', setName ?? ctx.ix.byId.get(ids[0])!.name.replace(/=.*$/, ''), {
        isComponentSet: true,
        layoutMode: 'VERTICAL',
        itemSpacing: 20,
        padding: 20,
        layoutSizingHorizontal: 'HUG',
        layoutSizingVertical: 'HUG',
        strokes: [{ type: 'SOLID', color: '#9747FF' }],
        dashPattern: [6, 4],
        cornerRadius: 5,
      })
      return ok({ componentSet: outline(res.ix, res.id, 1) })
    }
    return ok({ components: ids.map((id) => outline(ix, id, 1)) })
  },
)

tool(
  'create_instance',
  'Place an instance of a main component (same page as the component). Returns the instance tree; each layer has sourceId pointing at the component layer it mirrors. Use overrides to change text, fills etc. of individual layers of this instance.',
  {
    fileId,
    componentId: z.string(),
    parentId: z.string().optional().describe('FRAME/GROUP to place the instance in; omit for page level'),
    index: z.number().int().min(0).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    name: z.string().optional(),
    overrides: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe('[{ target: <component layer id or layer name>, ...props }] e.g. [{target:"Label", characters:"Buy now"}, {target:"Background", fill:"#FF0000"}]'),
  },
  async ({ fileId, componentId, parentId, index, x, y, name, overrides }) => {
    const ctx = await pageOfNodes(fileId, parentId ? [componentId, parentId] : [componentId])
    const main = ctx.ix.byId.get(componentId)!
    if (!main.isComponent) throw new Error(`${componentId} is not a main component (use create_component first)`)
    if (parentId && (parentId === componentId || ancestors(ctx.ix, parentId).includes(componentId))) throw new Error('An instance cannot be placed inside its own component')
    const { nodes, idMap } = cloneSubtrees(ctx.ix, [componentId])
    toInstance(ctx.ix, nodes, idMap, componentId)
    const root = nodes.find((n) => n.id === idMap.get(componentId))!
    const siblings = kids(ctx.ix, parentId ?? ROOT)
    if (parentId) root.parentId = parentId
    else delete root.parentId
    delete root.rotation
    if (name) root.name = name
    if (x === undefined && y === undefined && !parentId) {
      const b = boundsOf(corners(worldMatrix(ctx.ix, componentId), main.width, main.height))
      const right = Math.max(...siblings.map((id) => {
        const n = ctx.ix.byId.get(id)!
        const bb = boundsOf(corners(worldMatrix(ctx.ix, id), n.width, n.height))
        return bb.x + bb.w
      }))
      root.x = right + 100
      root.y = b.y
    } else {
      root.x = x ?? 0
      root.y = y ?? 0
    }
    for (const o of overrides ?? []) {
      const target = String(o.target ?? '')
      const hit = nodes.find((n) => n.id !== root.id && (n.sourceId === target || n.name === target)) ?? (target === componentId || target === main.name ? root : undefined)
      if (!hit) throw new Error(`Override target "${target}" not found in the component. Layers: ${descendants(ctx.ix, componentId).map((id) => ctx.ix.byId.get(id)!.name).join(', ')}`)
      const props = normalizeProps(o)
      delete props.target
      Object.assign(hit, props)
      hit.overrides = [...new Set([...(hit.overrides ?? []), ...Object.keys(props)])]
    }
    const at = index === undefined ? siblings.length : Math.min(index, siblings.length)
    const ops: Op[] = []
    ;[...siblings.slice(0, at), root.id, ...siblings.slice(at)].forEach((id, i) => {
      if (id === root.id) root.order = i
      else if (ctx.ix.byId.get(id)!.order !== i) ops.push({ op: 'update', id, patch: { order: i } })
    })
    const ix = await write(ctx, [...nodes.map((n) => ({ op: 'create' as const, node: n })), ...ops], [root.id])
    return ok({ instance: outline(ix, root.id, 20) })
  },
)

tool('detach_instance', 'Turn instances back into plain frames (they stop following their component).', { fileId, ids: z.array(z.string()).min(1) }, async ({ fileId, ids }) => {
  const ctx = await pageOfNodes(fileId, ids)
  const ops: Op[] = []
  for (const id of ids) {
    const n = ctx.ix.byId.get(id)!
    if (!n.componentId || n.sourceId) throw new Error(`${id} is not a top-level instance`)
    ops.push({ op: 'update', id, patch: { componentId: null, overrides: null } })
    const walk = (pid: string, nested: boolean) => {
      for (const c of kids(ctx.ix, pid)) {
        const cn = ctx.ix.byId.get(c)!
        const src = cn.sourceId ? ctx.ix.byId.get(cn.sourceId) : undefined
        ops.push({ op: 'update', id: c, patch: { sourceId: nested && src?.sourceId ? src.sourceId : null, overrides: null } })
        walk(c, nested || !!cn.componentId)
      }
    }
    walk(id, false)
  }
  const ix = await write(ctx, ops, ids)
  return ok({ detached: ids.map((id) => outline(ix, id, 1)) })
})

// ---------- prototype ----------
tool(
  'add_interaction',
  'Add a prototype interaction to a node (e.g. clicking a button navigates to another frame). Replaces an existing interaction with the same trigger.',
  {
    fileId,
    nodeId: z.string(),
    trigger: z.enum(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'AFTER_TIMEOUT']).optional().describe('Default ON_CLICK'),
    action: z.enum(['NAVIGATE', 'OVERLAY', 'CLOSE_OVERLAY', 'BACK', 'URL']).optional().describe('Default NAVIGATE'),
    destinationId: z.string().optional().describe('Top-level FRAME to navigate to / open as overlay'),
    url: z.string().optional(),
    transition: z.enum(['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'MOVE_IN', 'PUSH', 'SLIDE_IN']).optional(),
    direction: z.enum(['LEFT', 'RIGHT', 'TOP', 'BOTTOM']).optional(),
    duration: z.number().optional().describe('ms'),
    timeout: z.number().optional().describe('ms, for AFTER_TIMEOUT'),
  },
  async ({ fileId, nodeId, trigger, action, destinationId, url, transition, direction, duration, timeout }) => {
    const ctx = await pageOfNodes(fileId, destinationId ? [nodeId, destinationId] : [nodeId])
    const n = ctx.ix.byId.get(nodeId)!
    const act = action ?? 'NAVIGATE'
    if ((act === 'NAVIGATE' || act === 'OVERLAY') && !destinationId) throw new Error(`${act} needs destinationId (a top-level FRAME)`)
    if (destinationId && (ctx.ix.byId.get(destinationId)!.type !== 'FRAME' || ctx.ix.byId.get(destinationId)!.parentId)) throw new Error('destinationId must be a top-level FRAME')
    const r: Record<string, unknown> = { trigger: trigger ?? 'ON_CLICK', action: act }
    if (destinationId) r.destinationId = destinationId
    if (url) r.url = url
    if (act === 'NAVIGATE' || act === 'OVERLAY') {
      r.transition = transition ?? 'DISSOLVE'
      r.duration = duration ?? 300
      r.easing = 'EASE_OUT'
      if (direction) r.direction = direction
    }
    if (timeout !== undefined) r.timeout = timeout
    const reactions = [...(n.reactions ?? []).filter((x) => x.trigger !== r.trigger), r]
    await write(ctx, [{ op: 'update', id: nodeId, patch: { reactions } }], [nodeId])
    return ok({ nodeId, reactions })
  },
)

tool(
  'get_prototype_url',
  'URL that plays the prototype in the browser (presentation view), starting at a frame. Also lists the flow starting points of the page.',
  { fileId, pageId: pageIdOpt, frameId: z.string().optional().describe('Top-level frame to start from; default: first flow starting point or first frame') },
  async ({ fileId, pageId, frameId }) => {
    const ctx = frameId ? await pageOfNodes(fileId, [frameId]) : await loadPage(fileId, pageId)
    const frames = kids(ctx.ix, ROOT).map((id) => ctx.ix.byId.get(id)!).filter((n) => n.type === 'FRAME')
    return ok({
      url: `${APP_URL}/#/proto/${fileId}/${ctx.pageId}${frameId ? '/' + frameId : ''}`,
      flows: frames.filter((f) => f.flowStart).map((f) => ({ name: f.flowStart, frameId: f.id, frame: f.name })),
      frames: frames.map((f) => ({ frameId: f.id, name: f.name })),
    })
  },
)

tool('get_css', 'CSS for nodes (layout, colors, typography, effects) — handy when turning a design into code.', { fileId, ids: z.array(z.string()).min(1) }, async ({ fileId, ids }) => {
  const ctx = await pageOfNodes(fileId, ids)
  return ok(ids.map((id) => `/* ${ctx.ix.byId.get(id)!.name} */\n${cssText(ctx.ix, ctx.ix.byId.get(id)!)}`).join('\n\n'))
})

// ---------- shared styles ----------
const TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontSize', 'italic', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase']

tool('list_styles', 'List the shared color and text styles of a file.', { fileId }, async ({ fileId }) => {
  const rows = (await convex.query(api.styles.list, { fileId })) as { _id: string; kind: string; name: string; value: unknown }[]
  return ok(rows.map((s) => ({ styleId: s._id, kind: s.kind, name: s.name, value: s.value })))
})

tool(
  'create_style',
  'Create a shared style. PAINT styles hold fills (use fill:"#RRGGBB" or paints:[…]); TEXT styles hold typography (text:{fontFamily,fontWeight,fontSize,italic,lineHeight,letterSpacing,textDecoration,textCase}).',
  { fileId, kind: z.enum(['PAINT', 'TEXT']), name: z.string(), fill: z.string().optional(), paints: z.array(z.any()).optional(), text: z.record(z.string(), z.any()).optional() },
  async ({ fileId, kind, name, fill, paints, text }) => {
    const value = kind === 'PAINT' ? { paints: normalizePaints(paints ?? fill ?? '#000000', 'paints') } : { text: Object.fromEntries(Object.entries(text ?? {}).filter(([k]) => TEXT_STYLE_KEYS.includes(k))) }
    return ok({ styleId: await convex.mutation(api.styles.create, { fileId, kind, name, value }) })
  },
)

tool(
  'update_style',
  'Rename a shared style and/or change its value. Every node linked to the style is updated.',
  { styleId: z.string(), name: z.string().optional(), fill: z.string().optional(), paints: z.array(z.any()).optional(), text: z.record(z.string(), z.any()).optional() },
  async ({ styleId, name, fill, paints, text }) => {
    const value = paints || fill ? { paints: normalizePaints(paints ?? fill, 'paints') } : text ? { text } : undefined
    await convex.mutation(api.styles.update, { styleId, ...(name !== undefined ? { name } : {}), ...(value ? { value } : {}) })
    return ok({ updated: true })
  },
)

tool('delete_style', 'Delete a shared style. Linked nodes keep their current look but are unlinked.', { styleId: z.string() }, async ({ styleId }) => {
  await convex.mutation(api.styles.remove, { styleId })
  return ok({ deleted: true })
})

tool(
  'apply_style',
  'Link nodes to a shared style: a PAINT style sets their fills (or strokes with target:"stroke"), a TEXT style sets their typography.',
  { fileId, styleId: z.string(), ids: z.array(z.string()).min(1), target: z.enum(['fill', 'stroke']).optional() },
  async ({ fileId, styleId, ids, target }) => {
    const styles = (await convex.query(api.styles.list, { fileId })) as { _id: string; kind: string; value: { paints?: Paint[]; text?: Record<string, unknown> } }[]
    const style = styles.find((x) => x._id === styleId)
    if (!style) throw new Error(`Style ${styleId} not found in this file (see list_styles)`)
    const ctx = await pageOfNodes(fileId, ids)
    const patch: Record<string, unknown> =
      style.kind === 'TEXT'
        ? { ...(style.value.text ?? {}), textStyleId: styleId }
        : target === 'stroke'
          ? { strokes: style.value.paints ?? [], strokeStyleId: styleId }
          : { fills: style.value.paints ?? [], fillStyleId: styleId }
    const ix = await write(ctx, ids.map((id) => ({ op: 'update' as const, id, patch })), ids)
    return ok({ applied: ids.map((id) => outline(ix, id, 0)) })
  },
)

// ---------- version history ----------
tool('save_version', 'Save a named snapshot of the whole file to its version history (do this before large or risky changes).', { fileId, label: z.string().optional() }, async ({ fileId, label }) =>
  ok({ versionId: await convex.mutation(api.versions.save, { fileId, label, author: AGENT_NAME }) }),
)

tool('list_versions', 'List the saved versions of a file, newest first.', { fileId }, async ({ fileId }) => {
  const rows = (await convex.query(api.versions.list, { fileId })) as { _id: string; label: string; author?: string; createdAt: number; nodeCount: number }[]
  return ok(rows.map((v) => ({ versionId: v._id, label: v.label, author: v.author, createdAt: new Date(v.createdAt).toISOString(), layers: v.nodeCount })))
})

tool('restore_version', 'Replace the file contents with a saved version. The current state is saved as a new version first, so this can be undone by restoring that one.', { versionId: z.string() }, async ({ versionId }) => {
  await convex.mutation(api.versions.restore, { versionId, author: AGENT_NAME })
  return ok({ restored: true })
})

tool('ungroup_nodes', 'Dissolve GROUPs or FRAMEs, moving their children up one level (positions on canvas are kept).', { fileId, ids: z.array(z.string()).min(1) }, async ({ fileId, ids }) => {
  const ctx = await pageOfNodes(fileId, ids)
  const { ix } = ctx
  const ops: Op[] = []
  const freed: string[] = []
  for (const id of ids) {
    const g = ix.byId.get(id)!
    if (g.type !== 'GROUP' && g.type !== 'FRAME') throw new Error(`${id} is a ${g.type}, not a GROUP or FRAME`)
    const parent = parentOf(ix, id)
    const pm: Mat = parent === ROOT ? [1, 0, 0, 1, 0, 0] : worldMatrix(ix, parent)
    const children = kids(ix, id)
    for (const c of children) {
      const d = decompose(mul(invert(pm), worldMatrix(ix, c)))
      ops.push({ op: 'update', id: c, patch: { parentId: parent === ROOT ? null : parent, x: r2(d.x), y: r2(d.y), rotation: d.rotation || null } })
      freed.push(c)
    }
    ops.push({ op: 'delete', id })
    kids(ix, parent)
      .flatMap((k) => (k === id ? children : [k]))
      .forEach((k, i) => ops.push({ op: 'update', id: k, patch: { order: i } }))
  }
  await write(ctx, ops, freed)
  return ok({ ungrouped: ids.length, childIds: freed })
})

tool(
  'get_selection',
  'See what people currently have selected in the editor (and which page they are on). Useful to act on "the thing I selected".',
  { fileId },
  async ({ fileId }) => {
    const rows = (await convex.query(api.presence.list, { fileId })) as { name: string; pageId?: string; selection: string[]; isAgent?: boolean; updatedAt: number; x: number; y: number }[]
    const live = rows.filter((r) => !r.isAgent && Date.now() - r.updatedAt < 30_000)
    const out = []
    for (const r of live) {
      let nodes: unknown[] = []
      if (r.selection.length) {
        try {
          const ctx = await pageOfNodes(fileId, r.selection)
          nodes = r.selection.map((id) => outline(ctx.ix, id, 1))
        } catch {
          nodes = r.selection.map((id) => ({ id }))
        }
      }
      out.push({ user: r.name, pageId: r.pageId, cursor: { x: r2(r.x), y: r2(r.y) }, selection: nodes })
    }
    return ok(out.length ? out : 'Nobody has this file open in the editor right now.')
  },
)

tool(
  'set_selection',
  'Select nodes in every open editor and scroll/zoom the viewport to them — use it to show the user what you made. With no ids it zooms to fit the page.',
  { fileId, ids: z.array(z.string()).optional(), pageId: pageIdOpt, zoom: z.boolean().optional().describe('Zoom the viewport to the nodes (default true)') },
  async ({ fileId, ids, pageId, zoom }) => {
    const pid = ids?.length ? (await pageOfNodes(fileId, ids)).pageId : await resolvePage(fileId, pageId)
    await convex.mutation(api.commands.send, { fileId, type: 'select', payload: { pageId: pid, nodeIds: ids ?? [], zoom: zoom !== false } })
    return ok({ selected: ids ?? [], pageId: pid, url: fileUrl(fileId) })
  },
)

tool(
  'export_image',
  'Render nodes (or a whole page) to an image so you can look at the design. Returns a PNG (default) or SVG source. Text is drawn with system fonts, so glyph widths can differ slightly from the browser.',
  {
    fileId,
    pageId: pageIdOpt,
    nodeIds: z.array(z.string()).optional().describe('Nodes to render; omit to render the whole page'),
    scale: z.number().min(0.1).max(4).optional().describe('Scale factor (default 1; automatically reduced for very large exports)'),
    format: z.enum(['png', 'svg']).optional(),
  },
  async ({ fileId, pageId, nodeIds, scale, format }) => {
    const ctx = nodeIds?.length ? await pageOfNodes(fileId, nodeIds) : await loadPage(fileId, pageId)
    const ids = nodeIds?.length ? sortByDocOrder(ctx.ix, topLevelOnly(ctx.ix, nodeIds)) : kids(ctx.ix, ROOT)
    if (!ids.length) return ok('The page is empty — nothing to render.')
    let background: string | undefined
    if (!nodeIds?.length) {
      const pages = (await convex.query(api.pages.list, { fileId })) as { _id: string; background?: string }[]
      background = pages.find((p) => p._id === ctx.pageId)?.background ?? '#F5F5F5'
    }
    // Inline remote images so the renderer can draw them.
    const images = new Map<string, string>()
    if (format !== 'svg') {
      const urls = new Set<string>()
      for (const id of ids)
        for (const nid of [id, ...descendants(ctx.ix, id)])
          for (const p of ctx.ix.byId.get(nid)!.fills ?? []) if (p.type === 'IMAGE' && /^https?:/.test(p.url)) urls.add(p.url)
      await Promise.all(
        [...urls].slice(0, 30).map(async (u) => {
          try {
            const res = await fetch(u)
            if (!res.ok) return
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length < 8_000_000) images.set(u, `data:${res.headers.get('content-type') ?? 'image/png'};base64,${buf.toString('base64')}`)
          } catch {
            /* leave the image out */
          }
        }),
      )
    }
    const probe = exportSvg(ctx.ix, ids, { measure: estimateMeasure })
    let s = scale ?? 1
    const maxSide = Math.max(probe.width, probe.height) * s
    if (maxSide > 2400) s *= 2400 / maxSide
    const { svg, width, height } = exportSvg(ctx.ix, ids, { measure: estimateMeasure, background, scale: s, images })
    if (format === 'svg') return ok(svg)
    const png = new Resvg(svg, { font: fontOptions() }).render().asPng()
    return {
      content: [
        { type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
        { type: 'text' as const, text: `Rendered ${ids.length} node(s) at ${r2(s)}x → ${Math.round(width)}×${Math.round(height)}px` },
      ],
    }
  },
)

tool('list_comments', 'List comments pinned on the canvas (with replies).', { fileId, includeResolved: z.boolean().optional() }, async ({ fileId, includeResolved }) => {
  const rows = (await convex.query(api.comments.list, { fileId })) as { _id: string; pageId: string; x: number; y: number; author: string; text: string; resolved: boolean; replies: unknown[] }[]
  return ok(
    rows
      .filter((c) => includeResolved || !c.resolved)
      .map((c) => ({ commentId: c._id, pageId: c.pageId, x: r2(c.x), y: r2(c.y), author: c.author, text: c.text, resolved: c.resolved, replies: c.replies })),
  )
})

tool(
  'add_comment',
  'Pin a comment on the canvas at page coordinates (e.g. to leave feedback or a note for the user).',
  { fileId, pageId: pageIdOpt, x: z.number(), y: z.number(), text: z.string().min(1) },
  async ({ fileId, pageId, x, y, text }) => {
    const pid = await resolvePage(fileId, pageId)
    const id = await convex.mutation(api.comments.add, { fileId, pageId: pid, x, y, author: AGENT_NAME, color: '#D97757', text })
    return ok({ commentId: id })
  },
)

tool('reply_comment', 'Reply to a comment thread.', { commentId: z.string(), text: z.string().min(1) }, async ({ commentId, text }) => {
  await convex.mutation(api.comments.reply, { commentId, author: AGENT_NAME, text })
  return ok({ replied: true })
})

tool('resolve_comment', 'Mark a comment as resolved (or reopen it).', { commentId: z.string(), resolved: z.boolean().optional() }, async ({ commentId, resolved }) => {
  await convex.mutation(api.comments.setResolved, { commentId, resolved: resolved !== false })
  return ok({ resolved: resolved !== false })
})

registerParity({
  tool: tool as never,
  convex: convex as never,
  api,
  authSource: () => currentToken(CONVEX_URL)?.source ?? null,
  loadPage,
  pageOfNodes,
  write,
  ok,
  fileUrl,
  nodeGuide: NODE_GUIDE,
  appUrl: APP_URL,
  convexUrl: CONVEX_URL,
  agentName: AGENT_NAME,
  session: SESSION,
})

// ---------- transports ----------
/** Entry point of the standalone program (cli.ts): stdio by default, HTTP with --http <port>. */
export async function main() {
const httpFlag = process.argv.indexOf('--http')
const httpPort = httpFlag >= 0 ? Number(process.argv[httpFlag + 1]) || 3333 : process.env.FIGMA_CLONE_HTTP_PORT ? Number(process.env.FIGMA_CLONE_HTTP_PORT) : 0

if (!httpPort) await makeServer().connect(new StdioServerTransport())
else {
  // Streamable HTTP with OAuth: clients discover the authorization server through the protected-resource metadata,
  // sign the user in there, and send the resulting bearer token with every request.
  const base = (process.env.FIGMA_CLONE_PUBLIC_URL || `http://localhost:${httpPort}`).replace(/\/$/, '')
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' }
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...headers }).end(JSON.stringify(body))
  createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', base).pathname
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()
      if (path.startsWith('/.well-known/oauth-protected-resource')) return void send(res, 200, { resource: `${base}/mcp`, authorization_servers: [SITE_URL], bearer_methods_supported: ['header'], scopes_supported: ['files'] })
      if (path !== '/mcp') return void send(res, 404, { error: 'not_found' })
      const challenge = { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      if (!token) return void send(res, 401, { error: 'unauthorized', error_description: 'Sign in required' }, challenge)
      try {
        if (!(await client.query(api.users.me as never, { token } as never))) throw new Error('unknown token')
      } catch {
        return void send(res, 401, { error: 'invalid_token', error_description: 'The access token is invalid, expired or revoked' }, { 'WWW-Authenticate': challenge['WWW-Authenticate'] + ', error="invalid_token"' })
      }
      let body: unknown
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
        } catch {
          return void send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
        }
      }
      // Stateless: a fresh server per request, bound to the caller's token for the duration of the call.
      const server = makeServer(true)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
      await requestToken.run(token, async () => {
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      })
    } catch (e) {
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' }, id: null })
    }
  }).listen(httpPort, () => console.error(`figma-clone MCP server listening on ${base}/mcp (authorization server: ${SITE_URL})`))
}
}
