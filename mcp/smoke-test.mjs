// End-to-end check of the MCP server: spawns it over stdio and exercises the main tools.
// Usage: npm run build:mcp && node mcp/smoke-test.mjs   (the Convex backend must be running)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFileSync } from 'node:fs'

const client = new Client({ name: 'smoke-test', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: 'node', args: ['mcp/dist/server.mjs'] }))

let failures = 0
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content.find((c) => c.type === 'text')?.text ?? ''
  if (res.isError) {
    failures++
    console.log(`✗ ${name}: ${text}`)
    return { res, data: null }
  }
  let data = text
  try {
    data = JSON.parse(text)
  } catch {}
  console.log(`✓ ${name}`)
  return { res, data }
}
const expect = (cond, msg) => {
  if (!cond) {
    failures++
    console.log(`  ✗ expectation failed: ${msg}`)
  }
}

const tools = await client.listTools()
console.log(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`)

const { data: file } = await call('create_file', { name: 'MCP smoke test' })
const fileId = file.fileId

const { data: made } = await call('create_nodes', {
  fileId,
  nodes: [
    {
      type: 'FRAME',
      name: 'Card',
      width: 320,
      layoutMode: 'VERTICAL',
      padding: 24,
      itemSpacing: 12,
      fill: '#FFFFFF',
      cornerRadius: 16,
      effects: [{ type: 'DROP_SHADOW', color: '#000000', opacity: 0.15, x: 0, y: 8, blur: 24 }],
      children: [
        { type: 'TEXT', characters: 'Hello from MCP', fontSize: 24, fontWeight: 700 },
        { type: 'TEXT', characters: 'This card was built by an agent through the figma-clone MCP server.', fontSize: 14, fill: '#666666', layoutSizingHorizontal: 'FILL' },
        {
          type: 'FRAME',
          name: 'Button',
          layoutMode: 'HORIZONTAL',
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 10,
          paddingBottom: 10,
          cornerRadius: 8,
          fills: [{ type: 'GRADIENT_LINEAR', angle: 0, stops: [{ position: 0, color: '#0D99FF' }, { position: 1, color: '#9747FF' }] }],
          children: [{ type: 'TEXT', characters: 'Get started', fontSize: 14, fontWeight: 600, fill: '#FFFFFF' }],
        },
      ],
    },
    { type: 'ELLIPSE', name: 'Dot', width: 80, height: 80, fill: '#F24822' },
    { type: 'VECTOR', name: 'Check', width: 48, height: 48, vectorWidth: 24, vectorHeight: 24, vectorPath: 'M4 12l5 5L20 6', fills: [], stroke: '#14AE5C', strokeWeight: 3 },
  ],
})
const card = made.created[0]
expect(card.width === 320, 'card keeps explicit width')
expect(card.height > 100, `card hugs its content vertically (height ${card.height})`)
expect(card.children[1].width === 320 - 48, `FILL text spans the inner width (${card.children[1].width})`)
expect(made.created[1].x >= 420, `second root auto-placed to the right (x=${made.created[1].x})`)

const { data: tree } = await call('get_tree', { fileId })
expect(tree.nodes.length === 3, 'three root nodes')

const btn = card.children[2]
await call('update_nodes', { fileId, updates: [{ id: btn.id, cornerRadius: 20 }, { id: card.children[0].id, characters: 'Updated title', fill: '#0D99FF' }] })
const { data: got } = await call('get_nodes', { fileId, ids: [btn.id, card.children[0].id] })
expect(got[0].cornerRadius === 20, 'corner radius updated')
expect(got[1].characters === 'Updated title' && got[1].name === 'Updated title', 'text + auto name updated')

const { data: found } = await call('find_nodes', { fileId, text: 'get started' })
expect(found.length === 1 && found[0].path === 'Card / Button', `find by text (path ${found[0]?.path})`)

const { data: dup } = await call('duplicate_nodes', { fileId, ids: [made.created[1].id], offsetX: 120 })
const { data: grp } = await call('group_nodes', { fileId, ids: [made.created[1].id, dup.created[0].id], name: 'Dots' })
expect(grp.created.type === 'GROUP' && grp.created.width === 200, `group bounds (${grp.created.width})`)
await call('move_nodes', { fileId, ids: [made.created[2].id], parentId: card.id, index: 0 })
const { data: tree2 } = await call('get_tree', { fileId, nodeId: card.id })
expect(tree2.nodes[0].children[0].name === 'Check', 'vector moved into the card as first child')
await call('ungroup_nodes', { fileId, ids: [grp.created.id] })
await call('delete_nodes', { fileId, ids: [dup.created[0].id] })

await call('add_comment', { fileId, x: 0, y: -40, text: 'Smoke test comment' })
const { data: comments } = await call('list_comments', { fileId })
expect(comments.length === 1, 'one comment')
await call('get_selection', { fileId })
await call('set_selection', { fileId, ids: [card.id] })

const { res: img } = await call('export_image', { fileId, scale: 2 })
const png = img.content.find((c) => c.type === 'image')
expect(!!png, 'export_image returns a PNG')
if (png) {
  writeFileSync('mcp/dist/smoke-test.png', Buffer.from(png.data, 'base64'))
  console.log('  wrote mcp/dist/smoke-test.png')
}
const { data: svg } = await call('export_image', { fileId, nodeIds: [card.id], format: 'svg' })
expect(String(svg).startsWith('<svg'), 'svg export')

// ----- components & instances -----
const { data: btnMade } = await call('create_nodes', {
  fileId,
  nodes: [
    {
      type: 'FRAME',
      name: 'Btn',
      layoutMode: 'HORIZONTAL',
      padding: 12,
      fill: '#0D99FF',
      cornerRadius: 6,
      children: [{ type: 'TEXT', name: 'Label', characters: 'Button', fontSize: 14, fill: '#FFFFFF' }],
    },
  ],
})
const btnId = btnMade.created[0].id
const labelId = btnMade.created[0].children[0].id
await call('create_component', { fileId, ids: [btnId] })
const { data: comps } = await call('list_components', { fileId })
expect(comps.length === 1 && comps[0].componentId === btnId, 'component listed')
const { data: inst } = await call('create_instance', { fileId, componentId: btnId, overrides: [{ target: 'Label', characters: 'Buy now' }] })
const instId = inst.instance.id
const instLabel = inst.instance.children[0]
expect(inst.instance.componentId === btnId, 'instance links to its component')
expect(instLabel.sourceId === labelId && instLabel.characters === 'Buy now', `instance text override (${instLabel.characters})`)
expect(inst.instance.width > btnMade.created[0].width, `instance hugs its longer label (${inst.instance.width} > ${btnMade.created[0].width})`)
await call('update_nodes', { fileId, updates: [{ id: btnId, fill: '#F24822', cornerRadius: 12 }, { id: labelId, characters: 'Click', fontSize: 16 }] })
const { data: after } = await call('get_nodes', { fileId, ids: [instId, instLabel.id] })
expect(after[0].fills[0].color === '#F24822' && after[0].cornerRadius === 12, 'component change propagates to the instance')
expect(after[1].characters === 'Buy now' && after[1].fontSize === 16, `override survives while other props sync (${after[1].characters}, ${after[1].fontSize})`)
await call('create_nodes', { fileId, parentId: btnId, nodes: [{ type: 'ELLIPSE', name: 'Dot', width: 8, height: 8, fill: '#FFFFFF' }] })
const { data: instTree } = await call('get_tree', { fileId, nodeId: instId })
expect(instTree.nodes[0].children.length === 2, `layer added to the component appears in the instance (${instTree.nodes[0].children.length})`)
await call('update_nodes', { fileId, updates: [{ id: instLabel.id, fill: '#000000' }] })
const { data: ov } = await call('get_nodes', { fileId, ids: [instLabel.id] })
expect(ov[0].overrides.includes('fills') && ov[0].overrides.includes('characters'), `edits to instance layers are recorded as overrides (${ov[0].overrides})`)
await call('detach_instance', { fileId, ids: [instId] })
const { data: det } = await call('get_nodes', { fileId, ids: [instId, instLabel.id] })
expect(!det[0].componentId && !det[1].sourceId, 'detached instance is a plain frame')

// ----- constraints -----
const { data: cMade } = await call('create_nodes', {
  fileId,
  nodes: [
    {
      type: 'FRAME',
      name: 'Constrained',
      width: 200,
      height: 100,
      children: [
        { type: 'RECTANGLE', name: 'Right', x: 150, y: 10, width: 40, height: 20, constraints: { horizontal: 'MAX' } },
        { type: 'RECTANGLE', name: 'Stretch', x: 10, y: 60, width: 180, height: 20, constraints: { horizontal: 'STRETCH', vertical: 'MAX' } },
      ],
    },
  ],
})
const cf = cMade.created[0]
await call('update_nodes', { fileId, updates: [{ id: cf.id, width: 300, height: 150 }] })
const { data: cAfter } = await call('get_nodes', { fileId, ids: cf.children.map((c) => c.id) })
expect(cAfter[0].x === 250, `right-pinned child follows the edge (x=${cAfter[0].x})`)
expect(cAfter[1].width === 280 && cAfter[1].y === 110, `stretch + bottom constraints (w=${cAfter[1].width}, y=${cAfter[1].y})`)

// ----- boolean shapes -----
const { data: bMade } = await call('create_nodes', {
  fileId,
  nodes: [
    { type: 'RECTANGLE', name: 'A', x: 0, y: 400, width: 100, height: 100, fill: '#14AE5C' },
    { type: 'ELLIPSE', name: 'B', x: 50, y: 450, width: 100, height: 100 },
  ],
})
const { data: bool } = await call('boolean_operation', { fileId, ids: bMade.created.map((n) => n.id), operation: 'SUBTRACT' })
expect(bool.created.booleanOp === 'SUBTRACT' && bool.created.children.length === 2, 'boolean group created')
const { data: bsvg } = await call('export_image', { fileId, nodeIds: [bool.created.id], format: 'svg' })
expect(/fill-rule="evenodd"/.test(String(bsvg)) && String(bsvg).includes('#14AE5C') === false && /rgb\(20,174,92\)/.test(String(bsvg)), 'boolean result renders as one filled path')

// ----- prototype -----
const { data: screens } = await call('create_nodes', {
  fileId,
  nodes: [
    { type: 'FRAME', name: 'Screen 1', width: 200, height: 300, flowStart: 'Flow 1', children: [{ type: 'RECTANGLE', name: 'Next', x: 20, y: 20, width: 80, height: 32 }] },
    { type: 'FRAME', name: 'Screen 2', width: 200, height: 300 },
  ],
})
const { data: link } = await call('add_interaction', { fileId, nodeId: screens.created[0].children[0].id, destinationId: screens.created[1].id, transition: 'PUSH', direction: 'LEFT' })
expect(link.reactions.length === 1 && link.reactions[0].destinationId === screens.created[1].id, 'interaction added')
const { data: proto } = await call('get_prototype_url', { fileId })
expect(proto.url.includes('#/proto/') && proto.flows.length === 1, `prototype url (${proto.url})`)
const { data: css } = await call('get_css', { fileId, ids: [btnId] })
expect(String(css).includes('display: flex') && String(css).includes('border-radius: 12px'), 'css output')

// ----- shared styles -----
const { data: style } = await call('create_style', { fileId, kind: 'PAINT', name: 'Brand', fill: '#9747FF' })
await call('apply_style', { fileId, styleId: style.styleId, ids: [bMade.created[0].id] })
await call('update_style', { styleId: style.styleId, fill: '#FF24BD' })
const { data: styled } = await call('get_nodes', { fileId, ids: [bMade.created[0].id] })
expect(styled[0].fills[0].color === '#FF24BD' && styled[0].fillStyleId === style.styleId, `style change reaches linked nodes (${styled[0].fills[0].color})`)
const { data: styles } = await call('list_styles', { fileId })
expect(styles.length === 1, 'style listed')
await call('delete_style', { styleId: style.styleId })

// ----- version history -----
const { data: ver } = await call('save_version', { fileId, label: 'Smoke checkpoint' })
await call('delete_nodes', { fileId, ids: [cf.id] })
await call('restore_version', { versionId: ver.versionId })
const { data: restored } = await call('find_nodes', { fileId, name: 'Constrained' })
expect(restored.length === 1, 'restore_version brings deleted layers back')
const { data: vers } = await call('list_versions', { fileId })
expect(vers.length === 2, `versions listed, including the automatic pre-restore save (${vers.length})`)

// ----- Figma-compatible tools -----
const { data: me } = await call('whoami')
expect(me.handle && Array.isArray(me.projects), 'whoami')
const { data: pagesTxt } = await call('get_metadata', { fileKey: fileId })
expect(String(pagesTxt).startsWith('Pages:'), 'get_metadata without nodeId lists pages')
const { data: xml } = await call('get_metadata', { fileKey: fileId, nodeId: card.id })
expect(String(xml).includes(`<frame id="${card.id}"`) && String(xml).includes('<text '), 'get_metadata returns XML')
const { res: shot } = await call('get_screenshot', { fileKey: fileId, nodeId: card.id, maxDimension: 400 })
expect(shot.content.some((c) => c.type === 'image'), 'get_screenshot returns an image')

const { data: sugg } = await call('get_code_connect_suggestions', { fileKey: fileId, nodeId: btnId })
expect(sugg.unmappedComponents.some((c) => c.nodeId === btnId), 'unmapped component suggested')
await call('add_code_connect_map', { fileKey: fileId, nodeId: btnId, componentName: 'Button', source: 'src/components/Button.tsx', label: 'React' })
const { data: ccMap } = await call('get_code_connect_map', { fileKey: fileId, nodeId: btnId })
expect(ccMap[btnId]?.codeConnectName === 'Button', 'code connect mapping stored')
const { data: ccCtx } = await call('get_context_for_code_connect', { fileKey: fileId, nodeId: btnId })
expect(ccCtx.propertyDefinitions.Label?.type === 'TEXT', 'component context lists text properties')
const { data: host } = await call('create_nodes', { fileId, nodes: [{ type: 'FRAME', name: 'Toolbar', width: 300, height: 80, fill: '#FFFFFF' }] })
await call('create_instance', { fileId, componentId: btnId, parentId: host.created[0].id, x: 20, y: 20 })
const { res: dc } = await call('get_design_context', { fileKey: fileId, nodeId: host.created[0].id })
const dcCode = dc.content[0].text
expect(dcCode.includes('export default function Toolbar') && dcCode.includes('<Button data-node-id=') && dcCode.includes('from "src/components/Button.tsx"'), 'design context uses the Code Connect component')
expect(dc.content.some((c) => c.type === 'image'), 'design context includes a screenshot')
const { res: dc2 } = await call('get_design_context', { fileKey: fileId, nodeId: card.id, excludeScreenshot: true })
expect(dc2.content[0].text.includes('display: "flex"') && dc2.content[0].text.includes('Updated title'), 'design context emits layout and text')

const { data: found2 } = await call('search_design_system', { fileKey: fileId, queries: [{ entity: 'component', query: 'btn' }, { entity: 'style', query: 'zzz-nothing' }] })
expect(found2.results[0].items.some((i) => i.componentKey === btnId && i.local && i.codeConnect?.name === 'Button') && found2.results[1].items.length === 0, 'search_design_system')
const { data: libs } = await call('get_libraries', { fileKey: fileId })
expect(libs.libraries_added.length === 1 && libs.libraries_added[0].components >= 1, 'get_libraries')
const { data: other } = await call('create_new_file', { fileName: 'MCP smoke test (library target)' })
const { data: imported } = await call('import_component', { fileKey: other.fileKey, libraryKey: fileId, componentKey: btnId })
const { data: otherComps } = await call('list_components', { fileId: other.fileKey })
expect(otherComps.length === 1 && otherComps[0].componentId === imported.componentId, 'component imported into another file')

const { data: dia } = await call('generate_diagram', { name: 'Signup flow', fileKey: fileId, mermaidSyntax: 'flowchart LR\n  A["Start"] --> B{"Has account?"}\n  B -->|"yes"| C["Log in"]\n  B -->|"no"| D(["Sign up"])\n  C --> E(("Done"))\n  D --> E' })
const { data: diaXml } = await call('get_metadata', { fileKey: fileId, nodeId: dia.nodeId })
expect(['Start', 'Has account?', 'Log in', 'Sign up', 'Done'].every((t) => String(diaXml).includes(`name="${t}"`)), 'flowchart nodes created')
const { data: seq } = await call('generate_diagram', { name: 'Login sequence', fileKey: fileId, mermaidSyntax: 'sequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: POST /login\n  S-->>U: 200 OK' })
expect(seq.layers > 6, `sequence diagram created (${seq.layers} layers)`)
const { data: seqXml } = await call('get_metadata', { fileKey: fileId, nodeId: seq.nodeId })
expect((String(seqXml).match(/<frame /g) ?? []).length === 5, 'sequence diagram has exactly two participants (top and bottom boxes)')
const { data: st8 } = await call('generate_diagram', { name: 'States', fileKey: fileId, mermaidSyntax: 'stateDiagram-v2\n  [*]-->Idle\n  Idle-->Running: start\n  Running-->Idle: stop\n  Running-->[*]' })
const { data: stXml } = await call('get_metadata', { fileKey: fileId, nodeId: st8.nodeId })
expect(String(stXml).includes('name="Idle"') && String(stXml).includes('name="Running"') && !String(stXml).includes('name="Idle--'), 'state diagram parsed without spaces around arrows')

const { data: up } = await call('upload_assets', {
  fileKey: fileId,
  assets: [
    { name: 'Icon', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/><path d="M4 12l5 5L20 6" stroke="#14AE5C" fill="none" stroke-width="2"/></svg>' },
    { name: 'Pixel', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', mimeType: 'image/png' },
  ],
})
expect(up.uploaded[0].type === 'svg' && up.uploaded[0].layers === 2, 'SVG imported as vector layers')
expect(up.uploaded[1].type === 'image' && /^https?:/.test(up.uploaded[1].url), 'raster image uploaded to storage')
const { res: dl } = await call('download_assets', { fileKey: fileId, nodeId: up.uploaded[0].nodeId })
const dlMeta = JSON.parse(dl.content.find((c) => c.type === 'text').text)
expect(dlMeta.svgAssets.length === 2 && dl.content.some((c) => c.type === 'image'), 'download_assets returns export + svg assets')

const { data: skill } = await call('get_figma_skill', { uri: 'skill://figma/figma-use/SKILL.md' })
expect(String(skill).includes('figma.createFrame') || String(skill).includes('createFrame'), 'use_figma guide available')
const { data: script } = await call('use_figma', {
  fileKey: fileId,
  description: 'Build a card with the Plugin API',
  code: `
    await figma.loadFontAsync({ family: 'Inter', style: 'Bold' })
    const frame = figma.createFrame()
    frame.name = 'Scripted card'
    frame.x = 0; frame.y = 900
    frame.layoutMode = 'VERTICAL'
    frame.itemSpacing = 8
    frame.paddingLeft = frame.paddingRight = frame.paddingTop = frame.paddingBottom = 16
    frame.resize(240, 100)
    frame.primaryAxisSizingMode = 'AUTO'
    frame.fills = [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 } }]
    frame.cornerRadius = 12
    const title = figma.createText()
    title.fontName = { family: 'Inter', style: 'Bold' }
    title.characters = 'Hello plugin API'
    title.fontSize = 20
    title.setRangeFills(0, 5, [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }])
    frame.appendChild(title)
    const bar = figma.createRectangle()
    bar.resize(50, 6)
    frame.appendChild(bar)
    bar.layoutAlign = 'STRETCH'
    const dot = figma.getNodeById('${made.created[1].id}')
    dot.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }]
    dot.unknownThing = 1
    figma.currentPage.selection = [frame]
    return { frame, title, bar, count: figma.currentPage.findAll((n) => n.type === 'TEXT').length }
  `,
})
expect(script.changes.created === 3 && script.result.frame.type === 'FRAME' && script.result.count > 3, `use_figma created nodes (${JSON.stringify(script.changes)})`)
expect(script.warnings?.some((w) => w.includes('unknownThing')), 'unsupported properties are reported')
const { data: scripted } = await call('get_nodes', { fileId, ids: [script.result.frame.id, script.result.title.id, script.result.bar.id, made.created[1].id] })
expect(scripted[0].fills[0].color === '#FF8000' && scripted[0].layoutMode === 'VERTICAL' && scripted[0].width === 240 && scripted[0].height > 60 && scripted[0].height < 100, `scripted frame hugs its content (h=${scripted[0].height})`)
expect(scripted[1].fontWeight === 700 && scripted[1].textRuns?.[0]?.end === 5 && scripted[1].name === 'Hello plugin API', 'scripted text: font, range fill, auto name')
expect(scripted[2].width === 208 && scripted[2].layoutSizingHorizontal === 'FILL', `layoutAlign STRETCH fills the frame (w=${scripted[2].width})`)
expect(scripted[3].fills[0].color === '#0000FF', 'existing node edited by the script')
const { res: failing } = await client.callTool({ name: 'use_figma', arguments: { fileKey: fileId, description: 'fails', code: 'figma.createFrame(); throw new Error("boom")' } }).then((res) => ({ res }))
const { data: afterFail } = await call('find_nodes', { fileId, name: 'Frame' })
expect(failing.isError === true && !afterFail.some((n) => n.name === 'Frame'), 'a failing script saves nothing')

// ----- projects -----
const { data: proj } = await call('create_project', { name: 'Smoke project' })
await call('move_file', { fileId, projectId: proj.projectId })
const { data: inProj } = await call('list_files', { projectId: proj.projectId })
expect(inProj.length === 1 && inProj[0].fileId === fileId && inProj[0].project.name === 'Smoke project', 'file moved into the project')
const { data: projList } = await call('list_projects')
expect(projList.some((p) => p.projectId === proj.projectId && p.files === 1), 'project lists its file count')
await call('rename_project', { projectId: proj.projectId, name: 'Renamed project' })
await call('delete_project', { projectId: proj.projectId })
const { data: drafts } = await call('list_files', { draftsOnly: true })
expect(drafts.some((f) => f.fileId === fileId), 'deleting a project turns its files into drafts')

const { res: bad } = await client.callTool({ name: 'get_nodes', arguments: { fileId, ids: ['nope'] } }).then((res) => ({ res }))
expect(bad.isError === true, 'unknown ids produce a tool error')

console.log(failures ? `\n${failures} failure(s)` : `\nAll checks passed. File: ${file.url}`)
await client.close()
process.exit(failures ? 1 : 0)
