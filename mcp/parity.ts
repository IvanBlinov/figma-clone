// Tools that mirror the official Figma MCP server (same names and argument shapes where it makes sense),
// so agents and prompts written for Figma work against this clone.
import { Resvg } from '@resvg/resvg-js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import { isBoolean } from '../shared/boolean'
import { cssOf } from '../shared/css'
import { buildIndex, descendants, kids, ROOT, worldMatrix, type DocIndex } from '../shared/doc'
import { boundsOf, corners } from '../shared/geometry'
import { diffOps } from '../shared/resolve'
import { exportSvg } from '../shared/svg'
import { svgToNodes } from '../shared/svgParse'
import { cleanRuns, estimateMeasure } from '../shared/text'
import { newId, nodeLabel, type Op, type SceneNode } from '../shared/types'
import { buildDiagram } from './diagram'
import { runFigmaCode, USE_FIGMA_GUIDE, type PageModel, type StyleModel } from './figmaApi'

interface PageCtx {
  fileId: string
  pageId: string
  nodes: SceneNode[]
  ix: DocIndex
}
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ParityDeps {
  tool: (name: string, description: string, shape: any, handler: (args: any) => Promise<{ content: unknown[] }>) => void
  convex: { query: (fn: any, args: any) => Promise<any>; mutation: (fn: any, args: any) => Promise<any> }
  api: any
  loadPage: (fileId: string, pageId?: string) => Promise<PageCtx>
  pageOfNodes: (fileId: string, ids: string[]) => Promise<PageCtx>
  write: (ctx: PageCtx, ops: Op[], touched?: string[]) => Promise<DocIndex>
  ok: (data: unknown) => { content: { type: 'text'; text: string }[] }
  fileUrl: (fileId: string) => string
  nodeGuide: string
  appUrl: string
  convexUrl: string
  agentName: string
  session: string
}

const r2 = (v: number) => Math.round(v * 100) / 100
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const LABELS = ['React', 'Web Components', 'Vue', 'Svelte', 'Storybook', 'Javascript', 'Swift', 'Swift UIKit', 'Objective-C UIKit', 'SwiftUI', 'Compose', 'Java', 'Kotlin', 'Android XML Layout', 'Flutter', 'Markdown'] as const

const figType = (n: SceneNode) => (n.isComponentSet ? 'component-set' : n.isComponent ? 'component' : n.componentId ? 'instance' : n.booleanOp ? 'boolean-operation' : n.type.toLowerCase())

function metadataXml(ix: DocIndex, id: string, depth = 0): string {
  const n = ix.byId.get(id)!
  const pad = '  '.repeat(depth)
  const attrs = `id="${n.id}" name="${escXml(n.name)}" x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.width)}" height="${r2(n.height)}"${n.visible === false ? ' hidden="true"' : ''}`
  const children = isBoolean(n) ? [] : kids(ix, id)
  if (!children.length) return `${pad}<${figType(n)} ${attrs} />`
  return `${pad}<${figType(n)} ${attrs}>\n${children.map((c) => metadataXml(ix, c, depth + 1)).join('\n')}\n${pad}</${figType(n)}>`
}

function render(ix: DocIndex, ids: string[], maxDimension = 1024, background?: string) {
  const probe = exportSvg(ix, ids, { measure: estimateMeasure })
  const scale = Math.min(4, maxDimension / Math.max(probe.width, probe.height, 1))
  const { svg, width, height } = exportSvg(ix, ids, { measure: estimateMeasure, scale, background })
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng()
  return { png: Buffer.from(png).toString('base64'), width: Math.round(width), height: Math.round(height), original_width: Math.round(probe.width), original_height: Math.round(probe.height) }
}

function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
  }
  return null
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

export function registerParity(d: ParityDeps) {
  const { tool, convex, api, ok } = d
  const fileKey = z.string().describe('File id — the same value the other tools call fileId (from list_files, create_new_file, or an editor URL #/file/<id>)')
  const nodeId = z.string().describe('Node id (from get_metadata, get_tree, find_nodes, or get_selection)')
  const sessionId = z.string().optional().describe('Optional id returned by create_session')

  const rightOf = (ctx: PageCtx) => {
    const top = kids(ctx.ix, ROOT)
    if (!top.length) return { x: 0, y: 0 }
    const boxes = top.map((id) => boundsOf(corners(worldMatrix(ctx.ix, id), ctx.ix.byId.get(id)!.width, ctx.ix.byId.get(id)!.height)))
    return { x: Math.round(Math.max(...boxes.map((b) => b.x + b.w)) + 100), y: Math.round(Math.min(...boxes.map((b) => b.y))) }
  }
  const mappingsOf = async (fileId: string) => (await convex.query(api.library.codeConnectList, { fileId })) as { nodeId: string; componentName: string; source: string; label: string; template?: string }[]

  // ---------- identity / sessions / files ----------
  tool('whoami', 'Who the agent is acting as and which workspace it is connected to. There are no accounts, plans or seats here: every client has full access to the local workspace.', {}, async () => {
    const files = await convex.query(api.files.list, {})
    const projects = await convex.query(api.projects.list, {})
    return ok({ handle: d.agentName, email: null, backend: d.convexUrl, app: d.appUrl, plans: [{ key: 'local', name: 'Local workspace', seat: 'full' }], files: files.length, projects: projects.map((p: any) => ({ projectId: p._id, name: p.name })) })
  })

  tool(
    'create_session',
    'Announce that work on a file is starting. Shows the agent as present in that file for people who have it open and returns a session id (optional to pass to other tools).',
    { fileKey, description: z.string().describe('A concise description of the task') },
    async ({ fileKey }) => {
      const pages = await convex.query(api.pages.list, { fileId: fileKey })
      if (!pages.length) throw new Error(`File ${fileKey} not found (see list_files)`)
      await convex.mutation(api.presence.update, { fileId: fileKey, sessionId: d.session, name: d.agentName, color: '#D97757', pageId: pages[0]._id, x: 0, y: 0, selection: [], isAgent: true })
      return ok({ sessionId: randomUUID(), fileKey, url: d.fileUrl(fileKey) })
    },
  )

  tool(
    'create_new_file',
    'Create a new blank design file, in drafts or inside a project. Returns the file key and URL. (Same as create_file; named like the Figma tool.)',
    { fileName: z.string(), projectId: z.string().optional().describe('Project to put the file in; omit for drafts'), editorType: z.string().optional().describe('Only "design" files exist here; other values are accepted and create a design file'), planKey: z.string().optional().describe('Ignored (no plans in a local workspace)') },
    async ({ fileName, projectId }) => {
      const res = await convex.mutation(api.files.create, { name: fileName, ...(projectId ? { projectId } : {}) })
      return ok({ fileKey: res.fileId, pageId: res.pageId, url: d.fileUrl(res.fileId) })
    },
  )

  // ---------- reading designs ----------
  tool(
    'get_metadata',
    'Structure overview of a node or page in XML: node ids, layer types, names, positions and sizes only. Without nodeId it lists the pages of the file. When someone has layers selected in the editor, the response starts with a "Currently selected nodes" block. Prefer get_design_context when you need styling or code.',
    { fileKey, nodeId: z.string().optional().describe('Node id or page id; omit to list pages'), sessionId },
    async ({ fileKey, nodeId }) => {
      const pages = (await convex.query(api.pages.list, { fileId: fileKey })) as { _id: string; name: string }[]
      if (!pages.length) throw new Error(`File ${fileKey} not found (see list_files)`)
      let head = ''
      const rows = (await convex.query(api.presence.list, { fileId: fileKey })) as { isAgent?: boolean; updatedAt: number; selection: string[] }[]
      const sel = rows.filter((r) => !r.isAgent && Date.now() - r.updatedAt < 30_000).flatMap((r) => r.selection)
      if (sel.length) {
        try {
          const ctx = await d.pageOfNodes(fileKey, sel)
          head = 'Currently selected nodes:\n' + sel.map((id) => `- ${id} "${ctx.ix.byId.get(id)!.name}"`).join('\n') + '\n\n'
        } catch {
          /* selection vanished */
        }
      }
      if (!nodeId) return ok(head + 'Pages:\n' + pages.map((p) => `- ${p._id} "${p.name}"`).join('\n'))
      const page = pages.find((p) => p._id === nodeId)
      if (page) {
        const ctx = await d.loadPage(fileKey, page._id)
        return ok(`${head}<page id="${page._id}" name="${escXml(page.name)}">\n${kids(ctx.ix, ROOT).map((id) => metadataXml(ctx.ix, id, 1)).join('\n')}\n</page>`)
      }
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      return ok(head + metadataXml(ctx.ix, nodeId))
    },
  )

  tool(
    'get_screenshot',
    'Render a node to a PNG so you can look at it. maxDimension (default 1024) caps the longer edge. The image is returned inline together with its size and the node\'s natural size.',
    { fileKey, nodeId, maxDimension: z.number().int().min(16).max(8192).optional(), contentsOnly: z.boolean().optional().describe('Accepted for compatibility; nodes are always rendered in isolation'), enableBase64Response: z.boolean().optional().describe('Accepted for compatibility; the image is always inline'), sessionId },
    async ({ fileKey, nodeId, maxDimension }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const r = render(ctx.ix, [nodeId], maxDimension ?? 1024)
      return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ width: r.width, height: r.height, original_width: r.original_width, original_height: r.original_height }) }] }
    },
  )

  tool(
    'get_design_context',
    'Design-to-code context for a node: reference React code (inline styles, one element per layer, data-node-id attributes), the assets it references, the shared styles it uses, Code Connect mappings for components inside it, and a screenshot. Treat the code as a reference to adapt to the target project\'s components and conventions, not as final code.',
    {
      fileKey,
      nodeId,
      excludeScreenshot: z.boolean().optional(),
      disableCodeConnect: z.boolean().optional(),
      forceCode: z.boolean().optional().describe('Return code even when it is very large (otherwise large nodes return the metadata outline)'),
      clientLanguages: z.string().optional(),
      clientFrameworks: z.string().optional(),
      sessionId,
    },
    async ({ fileKey, nodeId, excludeScreenshot, disableCodeConnect, forceCode }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const { ix } = ctx
      const maps = disableCodeConnect ? [] : await mappingsOf(fileKey)
      const styles = (await convex.query(api.styles.list, { fileId: fileKey })) as { _id: string; name: string; kind: string; value: any }[]
      const assets: Record<string, unknown> = {}
      const imports = new Map<string, string>()
      const usedStyles = new Map<string, unknown>()
      let n = 0
      const camel = (k: string) => k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
      const styleAttr = (node: SceneNode, isRoot: boolean, extra: [string, string][] = []) => {
        let pairs = cssOf(ix, node)
        if (isRoot) pairs = pairs.filter(([k]) => k !== 'position' && k !== 'left' && k !== 'top')
        if (!isRoot && kids(ix, node.id).length && !pairs.some(([k]) => k === 'position')) pairs.unshift(['position', 'relative'])
        if (isRoot) pairs.unshift(['position', 'relative'])
        const all = [...pairs, ...extra]
        return all.length ? ` style={{ ${all.map(([k, v]) => `${camel(k)}: ${JSON.stringify(v)}`).join(', ')} }}` : ''
      }
      const emit = (id: string, depth: number, isRoot: boolean): string => {
        const node = ix.byId.get(id)!
        if (node.visible === false) return ''
        const pad = '  '.repeat(depth)
        for (const sid of [node.fillStyleId, node.strokeStyleId, node.textStyleId]) {
          const s = sid ? styles.find((x) => x._id === sid) : undefined
          if (s) usedStyles.set(s.name, s.kind === 'PAINT' ? (s.value.paints?.[0]?.color ?? s.value.paints) : s.value.text)
        }
        const mapKey = node.componentId ?? (node.isComponent ? node.id : undefined)
        const cc = mapKey ? maps.find((m) => m.nodeId === mapKey) : undefined
        if (cc && !isRoot) {
          imports.set(cc.componentName, cc.source)
          const texts = descendants(ix, id).map((x) => ix.byId.get(x)!).filter((x) => x.type === 'TEXT' && x.overrides?.includes('characters'))
          const hint = texts.length ? ` /* overrides: ${texts.map((t) => `${t.name}=${JSON.stringify(t.characters)}`).join(', ')} */` : ''
          return `${pad}<${cc.componentName} data-node-id="${id}" />${hint}`
        }
        const tag = `data-node-id="${id}" data-name=${JSON.stringify(node.name)}`
        if (node.type === 'TEXT') {
          const text = node.characters ?? ''
          const runs = cleanRuns(node.textRuns, text.length)
          let inner = ''
          let pos = 0
          for (const r of runs) {
            inner += escJsx(text.slice(pos, r.start))
            const st: string[] = []
            if (r.style.fontWeight) st.push(`fontWeight: ${r.style.fontWeight}`)
            if (r.style.fontSize) st.push(`fontSize: "${r.style.fontSize}px"`)
            if (r.style.italic) st.push(`fontStyle: "italic"`)
            if (r.style.textDecoration === 'UNDERLINE') st.push(`textDecoration: "underline"`)
            const f = r.style.fills?.[0]
            if (f?.type === 'SOLID') st.push(`color: "${f.color}"`)
            inner += `<span style={{ ${st.join(', ')} }}>${escJsx(text.slice(r.start, r.end))}</span>`
            pos = r.end
          }
          inner += escJsx(text.slice(pos))
          return `${pad}<p ${tag}${styleAttr(node, isRoot, [['margin', '0'], ['white-space', (node.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap']])}>${inner}</p>`
        }
        const vectorish = node.type === 'VECTOR' || node.type === 'POLYGON' || node.type === 'STAR' || isBoolean(node) || (node.type === 'LINE' && (node.arrowEnd || node.arrowStart))
        if (vectorish) {
          const name = `img${node.name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((w) => w[0]?.toUpperCase() + w.slice(1)).join('') || 'Vector'}${++n}`
          const svg = exportSvg(ix, [id], { measure: estimateMeasure }).svg
          assets[name] = { nodeId: id, type: 'svg', svg: svg.length > 6000 ? svg.slice(0, 6000) + '… (truncated — use download_assets)' : svg }
          const pairs = cssOf(ix, node).filter(([k]) => ['position', 'left', 'top', 'width', 'height', 'transform', 'transform-origin', 'opacity'].includes(k) && !(isRoot && ['position', 'left', 'top'].includes(k)))
          return `${pad}<img ${tag} alt="" src={${name}} style={{ ${pairs.map(([k, v]) => `${camel(k)}: ${JSON.stringify(v)}`).join(', ')} }} />`
        }
        for (const p of node.fills ?? []) if (p.type === 'IMAGE') assets[`image:${id}`] = { nodeId: id, type: 'image', url: p.url }
        const children = kids(ix, id).map((c) => emit(c, depth + 1, false)).filter(Boolean)
        const open = `${pad}<div ${tag}${styleAttr(node, isRoot)}`
        return children.length ? `${open}>\n${children.join('\n')}\n${pad}</div>` : `${open} />`
      }
      const root = ix.byId.get(nodeId)!
      const body = emit(nodeId, 2, true)
      const fn = (root.name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((w) => (w[0] ?? '').toUpperCase() + w.slice(1)).join('') || 'Design').replace(/^(\d)/, '_$1')
      const header = [...imports].map(([name, src]) => `import { ${name} } from ${JSON.stringify(src)} // Code Connect`).concat(Object.entries(assets).filter(([, a]) => (a as any).type === 'svg').map(([name]) => `const ${name} = "./assets/${name}.svg" // see assets["${name}"]`))
      const code = `${header.join('\n')}${header.length ? '\n\n' : ''}export default function ${fn}() {\n  return (\n${body}\n  )\n}\n`
      const content: unknown[] = []
      if (code.length > 80_000 && !forceCode)
        content.push({ type: 'text', text: `The generated code is very large (${code.length} characters), so only the structure is returned. Call get_design_context on smaller child nodes, or pass forceCode: true.\n\n${metadataXml(ix, nodeId)}` })
      else content.push({ type: 'text', text: code })
      content.push({
        type: 'text',
        text: JSON.stringify(
          {
            node: { id: nodeId, name: root.name, type: nodeLabel(root), width: r2(root.width), height: r2(root.height) },
            assets,
            styles: Object.fromEntries(usedStyles),
            codeConnect: Object.fromEntries(maps.filter((m) => [nodeId, ...descendants(ix, nodeId)].some((id) => (ix.byId.get(id)!.componentId ?? id) === m.nodeId)).map((m) => [m.nodeId, { codeConnectSrc: m.source, codeConnectName: m.componentName, label: m.label }])),
            notes: 'Reference code only: adapt it to the project\'s own components, tokens and styling approach. Text widths are estimated; fonts come from Google Fonts.',
          },
          null,
          1,
        ),
      })
      if (!excludeScreenshot) content.push({ type: 'image', data: render(ix, [nodeId], 1024).png, mimeType: 'image/png' })
      return { content }
    },
  )

  tool(
    'get_variable_defs',
    'Design tokens used by a node and its descendants, e.g. {"Brand/Primary": "#0D99FF"}. This workspace has shared color and text styles rather than Figma variables, so the tokens returned are the styles the node is linked to.',
    { fileKey, nodeId, sessionId },
    async ({ fileKey, nodeId }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const styles = (await convex.query(api.styles.list, { fileId: fileKey })) as { _id: string; name: string; kind: string; value: any }[]
      const out: Record<string, unknown> = {}
      for (const id of [nodeId, ...descendants(ctx.ix, nodeId)]) {
        const n = ctx.ix.byId.get(id)!
        for (const sid of [n.fillStyleId, n.strokeStyleId, n.textStyleId]) {
          const s = sid ? styles.find((x) => x._id === sid) : undefined
          if (!s) continue
          const p = s.value.paints?.[0]
          const t = s.value.text
          out[s.name] = s.kind === 'PAINT' ? (p?.type === 'SOLID' ? p.color : s.value.paints) : `Font(family: "${t?.fontFamily ?? 'Inter'}", size: ${t?.fontSize ?? 12}, weight: ${t?.fontWeight ?? 400}${t?.lineHeight ? `, lineHeight: ${t.lineHeight}` : ''})`
        }
      }
      return ok(out)
    },
  )

  tool('get_figjam', 'There are no FigJam boards in this workspace — diagrams made with generate_diagram are ordinary design layers. This returns the structure (XML) and a screenshot of a node, which is what you need to read such a diagram.', { fileKey, nodeId, includeImagesOfNodes: z.boolean().optional(), sessionId }, async ({ fileKey, nodeId, includeImagesOfNodes }) => {
    const ctx = await d.pageOfNodes(fileKey, [nodeId])
    const content: unknown[] = [{ type: 'text', text: metadataXml(ctx.ix, nodeId) }]
    if (includeImagesOfNodes !== false) content.push({ type: 'image', data: render(ctx.ix, [nodeId], 1024).png, mimeType: 'image/png' })
    return { content }
  })

  // ---------- design system ----------
  tool(
    'search_design_system',
    'Search components and styles across every file in the workspace (each file acts as a library). Pass queries as [{entity: "component" | "style" | "variable", query}]; results come back in the same order. "variable" searches color styles, which play the role of tokens here. To use a component found in another file, copy it in with import_component.',
    {
      fileKey: fileKey.describe('The file you are working in (its own assets are marked local)'),
      queries: z.array(z.object({ entity: z.enum(['component', 'variable', 'style']), query: z.string() })).min(1),
      includeLibraryKeys: z.array(z.string()).optional().describe('Restrict the search to these files (library keys = file ids)'),
      disableCodeConnect: z.boolean().optional(),
      sessionId,
    },
    async ({ fileKey, queries, includeLibraryKeys, disableCodeConnect }) => {
      const lib = await convex.query(api.library.assets, {})
      const maps = disableCodeConnect ? [] : await mappingsOf(fileKey)
      const match = (name: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => name.toLowerCase().includes(w))
      const allowed = (fid: string) => !includeLibraryKeys?.length || includeLibraryKeys.includes(fid)
      return ok({
        results: queries.map(({ entity, query }: { entity: string; query: string }) => ({
          entity,
          query,
          items:
            entity === 'component'
              ? lib.components
                  .filter((c: any) => allowed(c.fileId) && match(`${c.componentSet?.name ?? ''} ${c.name} ${c.description}`, query))
                  .slice(0, 40)
                  .map((c: any) => {
                    const cc = c.fileId === fileKey ? maps.find((m) => m.nodeId === c.nodeId) : undefined
                    return { name: c.componentSet ? `${c.componentSet.name} / ${c.name}` : c.name, componentKey: c.nodeId, libraryKey: c.fileId, libraryName: c.fileName, local: c.fileId === fileKey, pageId: c.pageId, width: r2(c.width), height: r2(c.height), ...(c.description ? { description: c.description } : {}), ...(cc ? { codeConnect: { name: cc.componentName, source: cc.source } } : {}) }
                  })
              : lib.styles
                  .filter((s: any) => allowed(s.fileId) && (entity === 'style' || s.kind === 'PAINT') && match(s.name, query))
                  .slice(0, 40)
                  .map((s: any) => ({ name: s.name, kind: s.kind, styleKey: s.styleId, libraryKey: s.fileId, libraryName: s.fileName, local: s.fileId === fileKey, value: s.value })),
        })),
      })
    },
  )

  tool(
    'get_libraries',
    'Libraries for a file. Here every file that contains components or styles is a library: the file itself is listed as added, all others as available (copy a component in with import_component). Library keys are file ids; pass them to search_design_system as includeLibraryKeys.',
    { fileKey, offset: z.number().int().min(0).optional(), sessionId },
    async ({ fileKey }) => {
      const lib = await convex.query(api.library.assets, {})
      const row = (f: { fileId: string; name: string }) => ({ name: f.name, libraryKey: f.fileId, sourceType: 'file', components: lib.components.filter((c: any) => c.fileId === f.fileId).length, styles: lib.styles.filter((s: any) => s.fileId === f.fileId).length })
      const rows = lib.files.map(row).filter((r: any) => r.components + r.styles > 0 || r.libraryKey === fileKey)
      return ok({ libraries_added: rows.filter((r: any) => r.libraryKey === fileKey), libraries_available_to_add: rows.filter((r: any) => r.libraryKey !== fileKey) })
    },
  )

  tool(
    'import_component',
    'Copy a main component (or a whole component set) from another file into this file so instances of it can be created here. Returns the new local component id.',
    { fileKey: fileKey.describe('Destination file'), libraryKey: z.string().describe('Source file id (from search_design_system / get_libraries)'), componentKey: z.string().describe('Component (or component set) node id in the source file'), pageId: z.string().optional().describe('Destination page; defaults to the first page') },
    async ({ fileKey, libraryKey, componentKey, pageId }) => {
      const src = (await convex.query(api.library.subtree, { fileId: libraryKey, nodeId: componentKey })) as SceneNode[] | null
      if (!src) throw new Error(`Component ${componentKey} not found in file ${libraryKey}`)
      if (!src[0].isComponent && !src[0].isComponentSet) throw new Error('componentKey must be a main component or a component set')
      const ctx = await d.loadPage(fileKey, pageId)
      const map = new Map(src.map((n) => [n.id, newId()]))
      const at = rightOf(ctx)
      const nodes = src.map((n, i) => {
        const c: SceneNode = { ...n, id: map.get(n.id)! }
        if (i === 0) {
          delete c.parentId
          c.x = at.x
          c.y = at.y
          c.order = kids(ctx.ix, ROOT).length
          delete c.rotation
        } else c.parentId = map.get(n.parentId!)
        // Links to nodes that were not copied (nested instances of other components, styles of the other file) are dropped.
        if (c.componentId && !map.has(c.componentId)) {
          delete c.componentId
          delete c.overrides
        } else if (c.componentId) c.componentId = map.get(c.componentId)
        if (c.sourceId) {
          if (map.has(c.sourceId)) c.sourceId = map.get(c.sourceId)
          else delete c.sourceId
        }
        if (libraryKey !== fileKey) {
          delete c.fillStyleId
          delete c.strokeStyleId
          delete c.textStyleId
        }
        delete c.reactions
        delete c.flowStart
        return c
      })
      await d.write(ctx, nodes.map((node) => ({ op: 'create' as const, node })), [nodes[0].id])
      return ok({ componentId: nodes[0].id, name: nodes[0].name, pageId: ctx.pageId, variants: nodes.filter((x) => x.isComponent && x.id !== nodes[0].id).map((x) => ({ componentId: x.id, name: x.name })) })
    },
  )

  // ---------- Code Connect ----------
  const mappingShape = { componentName: z.string().describe('Name of the component in the codebase, e.g. "Button"'), source: z.string().describe('Where the component lives in the codebase (path or URL)'), label: z.enum(LABELS).describe('Framework / language of this mapping'), template: z.string().optional(), templateDataJson: z.string().optional() }

  tool('add_code_connect_map', 'Map a design component to the code component that implements it (Code Connect). get_design_context then uses the code component instead of generating markup for its instances.', { fileKey, nodeId: nodeId.describe('Main component (or component set) node id'), ...mappingShape, sessionId }, async ({ fileKey, nodeId, componentName, source, label, template, templateDataJson }) => {
    await d.pageOfNodes(fileKey, [nodeId])
    await convex.mutation(api.library.codeConnectSet, { fileId: fileKey, mappings: [{ nodeId, componentName, source, label, ...(template ? { template } : {}), ...(templateDataJson ? { templateDataJson } : {}) }] })
    return ok({ mapped: { [nodeId]: { codeConnectSrc: source, codeConnectName: componentName, label } } })
  })

  tool(
    'send_code_connect_mappings',
    'Save several Code Connect mappings at once (typically after reviewing get_code_connect_suggestions with the user).',
    { fileKey, nodeId: z.string().optional().describe('The node the suggestions were requested for (informational)'), mappings: z.array(z.object({ nodeId: z.string(), ...mappingShape })).min(1), clientLanguages: z.string().optional(), clientFrameworks: z.string().optional(), sessionId },
    async ({ fileKey, mappings }) => {
      await d.pageOfNodes(fileKey, [...new Set(mappings.map((m: { nodeId: string }) => m.nodeId))] as string[])
      const n = await convex.mutation(api.library.codeConnectSet, { fileId: fileKey, mappings })
      return ok({ saved: n })
    },
  )

  tool('remove_code_connect_map', 'Remove the Code Connect mapping of a node (all labels, or one label).', { fileKey, nodeId, label: z.enum(LABELS).optional() }, async ({ fileKey, nodeId, label }) =>
    ok({ removed: await convex.mutation(api.library.codeConnectRemove, { fileId: fileKey, nodeId, ...(label ? { label } : {}) }) }),
  )

  tool(
    'get_code_connect_map',
    'Code Connect mappings for a node and the components used inside it: {[nodeId]: {codeConnectSrc, codeConnectName}}. For an instance, the mapping of its main component is reported under the main component id.',
    { fileKey, nodeId, codeConnectLabel: z.string().optional().describe('Only mappings with this framework label'), sessionId },
    async ({ fileKey, nodeId, codeConnectLabel }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const maps = (await mappingsOf(fileKey)).filter((m) => !codeConnectLabel || m.label === codeConnectLabel)
      const out: Record<string, unknown> = {}
      for (const id of [nodeId, ...descendants(ctx.ix, nodeId)]) {
        const n = ctx.ix.byId.get(id)!
        const key = n.componentId ?? id
        const m = maps.find((x) => x.nodeId === key)
        if (m) out[key] = { codeConnectSrc: m.source, codeConnectName: m.componentName, label: m.label }
      }
      return ok(out)
    },
  )

  tool(
    'get_code_connect_suggestions',
    'List the components used by a node (the node itself if it is a component, plus the main components of instances inside it) that have no Code Connect mapping yet, with enough detail (name, variants, layers) to find the matching code component. Review with the user, then save with send_code_connect_mappings.',
    { fileKey, nodeId, excludeMappingPrompt: z.boolean().optional().describe('Return only the list of unmapped components'), sessionId },
    async ({ fileKey, nodeId, excludeMappingPrompt }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const maps = await mappingsOf(fileKey)
      const seen = new Set<string>()
      const out = []
      for (const id of [nodeId, ...descendants(ctx.ix, nodeId)]) {
        const n = ctx.ix.byId.get(id)!
        const key = n.isComponent || n.isComponentSet ? id : n.componentId
        if (!key || seen.has(key) || maps.some((m) => m.nodeId === key)) continue
        seen.add(key)
        const main = ctx.ix.byId.get(key)
        if (!main) continue
        const set = main.parentId ? ctx.ix.byId.get(main.parentId) : undefined
        out.push({
          nodeId: key,
          name: set?.isComponentSet ? `${set.name} / ${main.name}` : main.name,
          ...(excludeMappingPrompt ? {} : { layers: descendants(ctx.ix, key).slice(0, 30).map((x) => ({ name: ctx.ix.byId.get(x)!.name, type: nodeLabel(ctx.ix.byId.get(x)!) })) }),
        })
      }
      return ok({ unmappedComponents: out, ...(excludeMappingPrompt ? {} : { nextStep: 'Search the codebase for a component matching each name, confirm with the user, then call send_code_connect_mappings with {nodeId, componentName, source, label}.' }) })
    },
  )

  tool(
    'get_context_for_code_connect',
    'Structured metadata for a component or component set, for writing Code Connect templates: property definitions (variant options, text layers, nested instances) and the tree of descendant text and instance layers.',
    { fileKey, nodeId, sessionId },
    async ({ fileKey, nodeId }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const { ix } = ctx
      const n = ix.byId.get(nodeId)!
      if (!n.isComponent && !n.isComponentSet) throw new Error(`${nodeId} is a ${nodeLabel(n)}; pass a main component or a component set`)
      const variants = n.isComponentSet ? kids(ix, nodeId).map((id) => ix.byId.get(id)!).filter((c) => c.isComponent) : []
      const props: Record<string, unknown> = {}
      for (const v of variants)
        for (const part of v.name.split(',')) {
          const [k, val] = part.split('=').map((s) => s.trim())
          if (!k || val === undefined) continue
          const p = (props[k] ??= { type: 'VARIANT', variantOptions: [] as string[] }) as { variantOptions: string[] }
          if (!p.variantOptions.includes(val)) p.variantOptions.push(val)
        }
      const base = variants[0]?.id ?? nodeId
      const tree = (id: string): unknown[] =>
        kids(ix, id).flatMap((c) => {
          const cn = ix.byId.get(c)!
          if (cn.type === 'TEXT') {
            props[cn.name] ??= { type: 'TEXT', defaultValue: cn.characters ?? '' }
            return [{ id: c, type: 'TEXT', name: cn.name, characters: cn.characters, propertyReference: cn.name }]
          }
          if (cn.componentId) {
            const main = ix.byId.get(cn.componentId)
            props[cn.name] ??= { type: 'INSTANCE_SWAP', defaultValue: cn.componentId, mainComponent: main?.name }
            return [{ id: c, type: 'INSTANCE', name: cn.name, mainComponentId: cn.componentId, mainComponentName: main?.name, propertyReference: cn.name }]
          }
          return tree(c)
        })
      const descendantsTree = tree(base)
      return ok({ id: nodeId, name: n.name, type: n.isComponentSet ? 'COMPONENT_SET' : 'COMPONENT', description: n.description ?? '', propertyDefinitions: props, variants: variants.map((v) => ({ id: v.id, name: v.name })), descendants: descendantsTree })
    },
  )

  // ---------- assets ----------
  tool(
    'upload_assets',
    'Put images and SVGs into a file. Each asset is given as a local file path, a URL, base64 data or SVG markup. Raster images (PNG, JPG, GIF, WebP) become the image fill of nodeId when given, otherwise a new image layer on the page. SVGs are imported as editable vector layers. Max 10 MB per asset, 60 assets per call.',
    {
      fileKey,
      assets: z
        .array(
          z.object({
            path: z.string().optional().describe('Local file path of the image / SVG'),
            url: z.string().optional().describe('http(s) URL to download the asset from'),
            base64: z.string().optional().describe('Base64-encoded file contents'),
            svg: z.string().optional().describe('SVG markup'),
            mimeType: z.string().optional().describe('e.g. image/png — needed for base64 when it cannot be detected'),
            name: z.string().optional().describe('Layer name'),
            nodeId: z.string().optional().describe('Existing node to set the raster image on as a fill'),
          }),
        )
        .min(1)
        .max(60),
      currentPageId: z.string().optional().describe('Page for new layers; defaults to the first page'),
      scaleMode: z.enum(['FILL', 'FIT', 'STRETCH', 'TILE']).optional(),
      sessionId,
    },
    async ({ fileKey, assets, currentPageId, scaleMode }) => {
      const results = []
      for (const a of assets as { path?: string; url?: string; base64?: string; svg?: string; mimeType?: string; name?: string; nodeId?: string }[]) {
        let buf: Buffer
        let mime = a.mimeType
        if (a.svg) {
          buf = Buffer.from(a.svg, 'utf8')
          mime = 'image/svg+xml'
        } else if (a.path) {
          if (!existsSync(a.path)) throw new Error(`File not found: ${a.path}`)
          mime ??= MIME[extname(a.path).toLowerCase()]
          if (!mime) throw new Error(`Unsupported file type for ${a.path} (PNG, JPG, GIF, WebP, SVG)`)
          buf = readFileSync(a.path)
        } else if (a.url) {
          const res = await fetch(a.url)
          if (!res.ok) throw new Error(`Could not download ${a.url}: HTTP ${res.status}`)
          buf = Buffer.from(await res.arrayBuffer())
          mime ??= res.headers.get('content-type')?.split(';')[0] ?? MIME[extname(new URL(a.url).pathname).toLowerCase()]
        } else if (a.base64) buf = Buffer.from(a.base64.replace(/^data:[^,]*,/, ''), 'base64')
        else throw new Error('Each asset needs one of: path, url, base64, svg')
        if (buf.length > 10 * 1024 * 1024) throw new Error('Assets are limited to 10 MB')
        const head = buf.subarray(0, 300).toString('utf8')
        if (!mime && /<svg[\s>]/i.test(head)) mime = 'image/svg+xml'
        const name = a.name ?? (a.path ? a.path.split(/[\\/]/).pop()!.replace(/\.\w+$/, '') : mime === 'image/svg+xml' ? 'SVG' : 'Image')
        const ctx = a.nodeId ? await d.pageOfNodes(fileKey, [a.nodeId]) : await d.loadPage(fileKey, currentPageId)
        if (mime === 'image/svg+xml') {
          const at = rightOf(ctx)
          const nodes = svgToNodes(buf.toString('utf8'), { name, x: at.x, y: at.y })
          if (!nodes) throw new Error(`"${name}" has no drawable shapes`)
          nodes[0].order = kids(ctx.ix, ROOT).length
          await d.write(ctx, nodes.map((node) => ({ op: 'create' as const, node })), [nodes[0].id])
          results.push({ name, type: 'svg', nodeId: nodes[0].id, layers: nodes.length - 1 })
          continue
        }
        const size = imageSize(buf)
        if (!size && !mime) throw new Error(`Could not recognise "${name}" as an image; pass mimeType`)
        const uploadUrl = await convex.mutation(api.images.generateUploadUrl, {})
        const res = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': mime ?? 'image/png' }, body: new Uint8Array(buf) })
        if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
        const { storageId } = (await res.json()) as { storageId: string }
        const url = (await convex.mutation(api.images.getUrl, { storageId })) as string
        const fill = { type: 'IMAGE' as const, url, scaleMode: scaleMode === 'FIT' ? ('FIT' as const) : scaleMode === 'STRETCH' ? ('STRETCH' as const) : ('FILL' as const) }
        if (a.nodeId) {
          await d.write(ctx, [{ op: 'update', id: a.nodeId, patch: { fills: [fill] } }], [a.nodeId])
          results.push({ name, type: 'image', targetNodeId: a.nodeId, url })
        } else {
          const at = rightOf(ctx)
          const k = size ? Math.min(1, 1200 / Math.max(size.w, size.h)) : 1
          const node: SceneNode = { id: newId(), order: kids(ctx.ix, ROOT).length, type: 'RECTANGLE', name, x: at.x, y: at.y, width: Math.round((size?.w ?? 400) * k), height: Math.round((size?.h ?? 300) * k), fills: [fill] }
          await d.write(ctx, [{ op: 'create', node }], [node.id])
          results.push({ name, type: 'image', nodeId: node.id, url, width: node.width, height: node.height })
        }
      }
      return ok({ uploaded: results })
    },
  )

  tool(
    'download_assets',
    'Assets of a node: an export of the whole node (PNG inline, or SVG source), the original images used as fills anywhere inside it (URLs), and SVGs of its vector layers (icons, logos; capped at 20).',
    { fileKey, nodeId, defaultFormat: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().describe('png (default) or svg; jpg and pdf are exported as png'), defaultScale: z.number().min(0.01).max(4).optional(), sessionId },
    async ({ fileKey, nodeId, defaultFormat, defaultScale }) => {
      const ctx = await d.pageOfNodes(fileKey, [nodeId])
      const { ix } = ctx
      const all = [nodeId, ...descendants(ix, nodeId)].map((id) => ix.byId.get(id)!)
      const rawImages = []
      for (const n of all) for (const p of n.fills ?? []) if (p.type === 'IMAGE' && rawImages.length < 20) rawImages.push({ nodeId: n.id, name: n.name, url: p.url, format: (p.url.match(/\.(png|jpe?g|gif|webp)(\?|$)/i)?.[1] ?? 'original').toLowerCase().replace('jpg', 'jpeg') })
      const svgAssets = all
        .filter((n) => n.id !== nodeId && n.visible !== false && (n.type === 'VECTOR' || n.type === 'POLYGON' || n.type === 'STAR' || isBoolean(n)))
        .slice(0, 20)
        .map((n) => ({ nodeId: n.id, name: n.name, format: 'svg', svg: exportSvg(ix, [n.id], { measure: estimateMeasure }).svg }))
      const content: unknown[] = []
      const root = ix.byId.get(nodeId)!
      if (defaultFormat === 'svg') content.push({ type: 'text', text: JSON.stringify({ export: { format: 'svg', svg: exportSvg(ix, [nodeId], { measure: estimateMeasure, scale: defaultScale ?? 1 }).svg }, rawImages, svgAssets }, null, 1) })
      else {
        const r = render(ix, [nodeId], Math.min(4096, Math.max(root.width, root.height, 1) * (defaultScale ?? 1)))
        content.push({ type: 'image', data: r.png, mimeType: 'image/png' })
        content.push({ type: 'text', text: JSON.stringify({ export: { format: 'png', width: r.width, height: r.height, ...(defaultFormat && defaultFormat !== 'png' ? { note: `${defaultFormat} export is not available; PNG returned` } : {}) }, rawImages, svgAssets }, null, 1) })
      }
      return { content }
    },
  )

  // ---------- diagrams ----------
  tool(
    'generate_diagram',
    'Create a diagram from Mermaid syntax as editable layers: graph / flowchart, sequenceDiagram, stateDiagram(-v2), erDiagram and gantt are supported. Without fileKey a new file is created for it. Use LR direction by default for flowcharts and put shape and edge text in quotes (["Text"], -->|"Edge text"|). Keep diagrams simple unless asked otherwise.',
    { name: z.string().describe('Short title of the diagram'), mermaidSyntax: z.string(), fileKey: z.string().optional().describe('Existing file to add the diagram to; omit to create a new file'), pageId: z.string().optional(), projectId: z.string().optional().describe('Project for the new file (when fileKey is omitted)'), userIntent: z.string().optional(), sessionId },
    async ({ name, mermaidSyntax, fileKey, pageId, projectId }) => {
      let fid = fileKey as string | undefined
      if (!fid) fid = (await convex.mutation(api.files.create, { name, ...(projectId ? { projectId } : {}) })).fileId as string
      const ctx = await d.loadPage(fid, pageId)
      const at = rightOf(ctx)
      const nodes = buildDiagram(name, mermaidSyntax, at.x, at.y)
      nodes[0].order = kids(ctx.ix, ROOT).length
      const ix = await d.write(ctx, nodes.map((node) => ({ op: 'create' as const, node })), [nodes[0].id])
      return { content: [{ type: 'text', text: JSON.stringify({ fileKey: fid, pageId: ctx.pageId, nodeId: nodes[0].id, layers: nodes.length - 1, url: d.fileUrl(fid) }) }, { type: 'image', data: render(ix, [nodes[0].id], 1024).png, mimeType: 'image/png' }] }
    },
  )

  // ---------- scripting ----------
  tool(
    'use_figma',
    `Run JavaScript against a file through a Figma Plugin API compatible \`figma\` global — the general-purpose way to create, edit or inspect designs with code written for Figma (figma.createFrame(), node.fills = [...], frame.layoutMode = 'VERTICAL', await figma.loadFontAsync(...)). The code runs as an async function body; return a value to get it back. Changes are saved only if the script finishes without throwing. Read the supported API subset first: get_figma_skill with uri "skill://figma/figma-use/SKILL.md". For simple edits the dedicated tools (create_nodes, update_nodes, …) are more direct.`,
    { fileKey, code: z.string().max(50000).describe('JavaScript to execute; has access to the `figma` global'), description: z.string().describe('What the code is meant to do'), pageId: z.string().optional().describe('Page that figma.currentPage starts on; defaults to the first page'), sessionId },
    async ({ fileKey, code, pageId }) => {
      const file = await convex.query(api.files.get, { fileId: fileKey })
      const pageRows = (await convex.query(api.pages.list, { fileId: fileKey })) as { _id: string; name: string }[]
      if (!file || !pageRows.length) throw new Error(`File ${fileKey} not found (see list_files)`)
      const before = new Map<string, SceneNode[]>()
      const pages: PageModel[] = []
      for (const p of pageRows) {
        const nodes = (await convex.query(api.nodes.list, { pageId: p._id })) as SceneNode[]
        before.set(p._id, nodes)
        pages.push({ pageId: p._id, name: p.name, nodes: structuredClone(nodes) })
      }
      const styleRows = (await convex.query(api.styles.list, { fileId: fileKey })) as { _id: string; kind: 'PAINT' | 'TEXT'; name: string; value: any }[]
      const styles: StyleModel[] = styleRows.map((s) => ({ id: s._id, kind: s.kind, name: s.name, value: structuredClone(s.value) }))
      const run = await runFigmaCode(code, pages, pageId ?? pageRows[0]._id, styles, file.name)

      // Styles first, so nodes can point at their real ids.
      const styleIds = new Map<string, string>()
      for (const s of styles) {
        if (s.isNew) styleIds.set(s.id, (await convex.mutation(api.styles.create, { fileId: fileKey, kind: s.kind, name: s.name, value: s.value })) as string)
        else if (s.dirty) await convex.mutation(api.styles.update, { styleId: s.id, name: s.name, value: s.value })
      }
      const pageIds = new Map<string, string>()
      for (const p of pages) {
        if (p.isNew) pageIds.set(p.pageId, (await convex.mutation(api.pages.create, { fileId: fileKey, name: p.name })) as string)
        else if (p.name !== pageRows.find((r) => r._id === p.pageId)!.name) await convex.mutation(api.pages.update, { pageId: p.pageId, name: p.name })
        if (styleIds.size)
          for (const n of p.nodes)
            for (const k of ['fillStyleId', 'strokeStyleId', 'textStyleId'] as const) if (n[k] && styleIds.has(n[k]!)) n[k] = styleIds.get(n[k]!)
      }
      const real = (id: string) => pageIds.get(id) ?? id
      const emptyIx = buildIndex([])
      const plan = pages.map((p) => ({ pageId: real(p.pageId), ops: diffOps(before.get(p.pageId) ?? [], p.nodes) }))
      const counts = { created: 0, updated: 0, deleted: 0 }
      // Deletions go first so a node moved to another page is not removed after it was re-created there.
      for (const phase of ['delete', 'rest'] as const)
        for (const p of plan) {
          const ops = p.ops.filter((o) => (o.op === 'delete') === (phase === 'delete'))
          if (!ops.length) continue
          for (const o of ops) counts[o.op === 'create' ? 'created' : o.op === 'update' ? 'updated' : 'deleted']++
          await d.write({ fileId: fileKey, pageId: p.pageId, nodes: [], ix: emptyIx }, ops, ops.flatMap((o) => (o.op === 'create' ? [o.node.id] : o.op === 'update' ? [o.id] : [])).slice(0, 20))
        }
      if (run.selection) await convex.mutation(api.commands.send, { fileId: fileKey, type: 'select', payload: { pageId: real(run.selection.pageId), nodeIds: run.selection.ids, zoom: true } })
      return ok({ result: run.result ?? null, changes: counts, ...(run.logs.length ? { logs: run.logs.slice(0, 100) } : {}), ...(run.warnings.length ? { warnings: run.warnings } : {}), ...(pageIds.size ? { newPages: [...pageIds.values()] } : {}), url: d.fileUrl(fileKey) })
    },
  )

  tool(
    'get_figma_skill',
    'Read guidance for working with this server by skill:// URI: the index ("skill://index.json"), the use_figma API reference ("skill://figma/figma-use/SKILL.md"), the design-to-code workflow ("skill://figma/figma-design-to-code/SKILL.md"), or the node model used by create_nodes / update_nodes ("skill://figma/node-model/SKILL.md").',
    { uri: z.string() },
    async ({ uri }) => {
      const docs: Record<string, string> = {
        'skill://figma/figma-use/SKILL.md': USE_FIGMA_GUIDE,
        'skill://figma/node-model/SKILL.md': d.nodeGuide,
        'skill://figma/figma-design-to-code/SKILL.md': `# Design to code\n\n1. get_metadata (no nodeId) to list pages, then get_metadata on a page to find the frame to implement — or get_selection for what the user has selected.\n2. get_design_context on that frame: reference React code, assets, styles and a screenshot. For large frames, call it on child sections.\n3. Check search_design_system / get_code_connect_map for components that already exist in code and reuse them rather than re-creating markup.\n4. Adapt the reference code to the project's framework, components and tokens (get_variable_defs lists the styles in use); do not paste inline styles verbatim when the project has a design system.\n5. download_assets for images and SVG icons; get_screenshot to compare your result with the design.`,
      }
      if (uri === 'skill://index.json') return ok({ skills: Object.keys(docs).map((u) => ({ uri: u, name: u.split('/')[3] })) })
      if (!docs[uri]) throw new Error(`Unknown skill URI ${uri}. Available: skill://index.json, ${Object.keys(docs).join(', ')}`)
      return ok(docs[uri])
    },
  )
}

const escJsx = (s: string) => s.replace(/[{}<>]/g, (c) => `{'${c}'}`).replace(/\n/g, '{"\\n"}')
