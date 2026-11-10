# Figma Clone

A collaborative design editor in the spirit of Figma — canvas, layers, properties, auto layout, multiplayer — with a
**Convex** backend and an **MCP server** so AI agents can read and edit designs autonomously while you watch.

**Live:** https://ivanblinov.github.io/figma-clone/ — frontend on GitHub Pages, backend on Convex (project `figma`).

## Run it

```bash
npm install
npm run dev:backend   # syncs convex/ to your Convex dev deployment and writes .env.local
npm run dev           # editor at http://localhost:5173 (uses the dev deployment)
npm run build:mcp     # bundle the MCP server → mcp/dist/server.mjs
```

`dev:backend` needs a Convex login (`npx convex login`). To work fully offline instead, run
`npm run dev:backend:local`, which uses Convex's anonymous local deployment (no account needed).

## Deploy

| Part | Where | How |
| --- | --- | --- |
| Backend | Convex production deployment `adorable-magpie-715` | `npm run deploy:backend` |
| Frontend | GitHub Pages | Every push to `main` runs `.github/workflows/pages.yml`, which builds with the URL in `.env.production` and publishes `dist/` |

Deploy the backend before pushing frontend changes that depend on new backend functions. Local development
talks to the separate dev deployment, so it never touches production data.

The backend has **no authentication**: anyone who opens the site can view, edit and delete every file.

## Connect an agent (MCP)

The repo ships a `.mcp.json`, so Claude Code started in this folder picks up the `figma-clone` server automatically
(approve it when prompted). For any other MCP client:

```json
{
  "mcpServers": {
    "figma-clone": { "command": "node", "args": ["<path-to-repo>/mcp/dist/server.mjs"] }
  }
}
```

Environment variables: `FIGMA_CLONE_CONVEX_URL` (default: `VITE_CONVEX_URL` from `.env.local`),
`FIGMA_CLONE_APP_URL` (default `http://localhost:5173`), `FIGMA_CLONE_AGENT_NAME` (default `Claude`). The bundled
`.mcp.json` points both URLs at production, so agents edit the same files the live site shows; remove the `env`
block to work against your local dev setup instead.

The backend must be running; the browser does not need to be open. When it is, agent edits appear live, the agent
shows up as a collaborator with its own cursor, and `set_selection` scrolls your viewport to what it built.

| Tool | Purpose |
| --- | --- |
| `list_files`, `create_file`, `rename_file`, `move_file` | Files |
| `list_projects`, `create_project`, `rename_project`, `delete_project` | Projects (a file without a project is a draft) |
| `list_pages`, `create_page`, `update_page`, `delete_page` | Pages (name, canvas background) |
| `get_tree`, `get_nodes`, `find_nodes` | Read the layer tree, full node properties, search by name/type/text |
| `create_nodes` | Create nested node trees (frames, auto layout, text with mixed styles, shapes, vectors, images, boolean groups, masks) in one call |
| `update_nodes`, `delete_nodes`, `move_nodes`, `duplicate_nodes`, `group_nodes`, `ungroup_nodes` | Edit structure and properties |
| `boolean_operation` | Union / subtract / intersect / exclude existing shapes |
| `list_components`, `create_component`, `create_instance`, `detach_instance` | Components, variants and instances (with per-instance overrides) |
| `add_interaction`, `get_prototype_url` | Prototype links between layers and frames, and the URL that plays them |
| `list_styles`, `create_style`, `update_style`, `delete_style`, `apply_style` | Shared color and text styles |
| `save_version`, `list_versions`, `restore_version` | Version history |
| `export_image` | Render a page or nodes to PNG/SVG so the agent can *see* its work |
| `get_css` | CSS for a node (design → code) |
| `get_selection`, `set_selection` | Read what the user has selected; select + zoom in open editors |
| `list_comments`, `add_comment`, `reply_comment`, `resolve_comment` | Canvas comments |

### Figma-compatible tools

The server also exposes the tools of the official Figma MCP server under the same names and argument shapes
(`fileKey` is the file id), so prompts and skills written for Figma work here:

| Figma tool | Here |
| --- | --- |
| `get_design_context` | Reference React code for a node, assets, styles in use, Code Connect components, screenshot |
| `get_metadata` | XML outline of a node or page (ids, types, names, geometry); lists pages without `nodeId` |
| `get_screenshot` | PNG of a node (`maxDimension`) |
| `get_variable_defs` | Tokens used by a node — shared color/text styles stand in for variables |
| `use_figma` | Runs Figma Plugin API JavaScript (`figma.createFrame()`, `node.fills = …`, auto layout, text ranges, components, booleans, styles) against the file; a failing script saves nothing. Supported subset: `get_figma_skill` → `skill://figma/figma-use/SKILL.md` |
| `search_design_system`, `get_libraries` | Components and styles across all files (every file is a library); `import_component` copies one into the current file |
| `add_code_connect_map`, `get_code_connect_map`, `get_code_connect_suggestions`, `send_code_connect_mappings`, `get_context_for_code_connect` (+ `remove_code_connect_map`) | Code Connect: map design components to code components |
| `upload_assets`, `download_assets` | Images into fills / new layers, SVG as editable vectors (from a path, URL, base64 or markup); export + source images + SVG icons out |
| `generate_diagram` | Mermaid flowchart / sequence / state / ER / gantt as editable layers |
| `create_new_file`, `create_session`, `whoami`, `get_figjam`, `get_figma_skill` | File creation in a project, presence, workspace info, guidance |

Not available, because they depend on Figma's hosted services or products that do not exist here:
`generate_figma_design` / `send_code_to_figma` (web page or code project → design), `generate_image`,
`generate_vector_illustration`, the shader, generative-plugin and Weave tools, `export_video` and
`get_motion_context` (no animation timeline), FigJam and Slides files, and real variables with modes.

`node mcp/smoke-test.mjs` exercises every tool end to end against the running backend.

## Editor features

- **Tools**: Move, Hand, Frame, Rectangle, Line, Arrow, Ellipse, Polygon, Star, Pen (bezier), Pencil (freehand), Text,
  Comment, image import (toolbar, drag & drop, paste), SVG import (paste SVG markup).
- **Canvas**: pan/zoom, marquee, deep select (double-click / Ctrl-click), move with smart snapping guides, resize
  (Shift = keep ratio, Alt = from center), rotate, Alt-drag duplicate, drag into/out of frames, frame labels, rulers,
  layout grids, Alt-hover distance measurements.
- **Vector editing**: double-click (or Enter on) a vector to edit its points — drag anchors and bezier handles, click a
  segment to add a point, double-click a point to toggle corner/smooth, Delete removes points. Flatten (Ctrl+E) turns
  any shapes into one editable vector.
- **Boolean operations**: union, subtract, intersect, exclude — non-destructive groups whose operands stay editable.
- **Masks**: Use as mask (Ctrl+Alt+M) clips the layers above the mask to its outline.
- **Components**: create component (Ctrl+Alt+K), instances (duplicate / Alt-drag / copy-paste a component, or the
  Assets tab), overrides on any instance layer, reset overrides, detach, swap, variants via component sets. Editing a
  main component updates its instances.
- **Text**: edited directly on the canvas with a real caret and selection; mixed styles inside one layer (select
  characters, then change weight, size, font, color, decoration — or Ctrl+B / I / U).
- **Layers**: tree with rename, lock, hide, multi-select, drag to reorder / reparent, search (Ctrl+F), multiple pages.
- **Properties**: position, size (aspect lock, min/max), rotation, alignment & distribution, constraints, auto layout
  (direction, gap, per-side padding, alignment, wrap, hug / fill / fixed), corner radius (per corner), opacity, blend
  modes, fills & strokes (solid, linear/radial gradient, image), arrowheads, effects (drop/inner shadow, layer blur),
  typography (Google Fonts), layout grids, shared color/text styles, export to PNG / JPG / SVG.
- **Prototype tab**: interactions (click, hover, press, delay → navigate, overlay, back, link) with dissolve, move in,
  push, slide and smart-animate transitions; drag the ⊕ handle from a layer to a frame to connect them; flow starting
  points; **Present** (▶) plays the prototype in a new tab.
- **Inspect tab**: measurements, generated CSS and the colors used by the selection. Copy as SVG / CSS / PNG.
- **File browser**: Recents, Drafts and projects — create, rename and delete projects, move files between them
  (right-click a file → Move to project).
- **Collaboration**: live cursors, remote selections, comments with replies, all synced through Convex.
- **Editing**: undo/redo, copy/paste (also between files), group / ungroup / frame selection, z-order, quick actions
  (Ctrl+/), version history (main menu → Save version / Version history).

Shortcuts follow Figma: `V H F R O L P T C` tools · `Shift+L` arrow · `Shift+P` pencil · `Ctrl+Z / Ctrl+Shift+Z` ·
`Ctrl+D` duplicate · `Ctrl+G` / `Ctrl+Shift+G` group / ungroup · `Ctrl+Alt+G` frame selection · `Shift+A` auto layout ·
`Ctrl+Alt+K` create component · `Ctrl+Alt+B` detach instance · `Ctrl+E` flatten · `Ctrl+Alt+M` mask ·
`Ctrl+B / I / U` text style · `[` `]` send to back / bring to front · `Ctrl+[` `Ctrl+]` backward / forward · arrows
nudge (`Shift` ×10) · `Alt+A/D/W/S/H/V` align · `1`–`0` opacity · `Shift+1` zoom to fit · `Shift+2` zoom to selection ·
`Ctrl+0` 100% · `Shift+R` rulers · `Shift+G` layout grids · `Shift+E` prototype tab · `Ctrl+/` quick actions ·
`Ctrl+F` find layers · `Space`-drag pan · `Ctrl+\` hide UI.

## Architecture

```
convex/    schema + functions (projects, files, pages, nodes, presence, comments, commands, styles, versions,
           Code Connect, image storage)
shared/    document model used by the editor, the backend and the MCP server:
           types, geometry, auto-layout engine, text layout (mixed styles), vector paths, boolean shapes,
           resolve (constraints + component instances), SVG export, CSS generation
src/       React editor (canvas renderer, interactions, panels), file browser, prototype player
mcp/       stdio MCP server (talks to Convex over HTTP, renders PNGs with resvg); parity.ts holds the
           Figma-compatible tools, figmaApi.ts the Plugin API shim behind use_figma, diagram.ts the Mermaid layout
```

- Every node is one row in the `nodes` table. All writes go through one mutation, `nodes.applyOps`
  (`create` / `update` / `delete` ops), which is what makes optimistic updates, undo/redo and agent edits uniform.
- `shared/resolve.ts` turns an edit into everything it implies before it is stored: auto layout, hug sizing, text
  measurement, group bounds, constraint-driven moves when a frame is resized, and component instances catching up
  with their main component (instances are real layers that mirror the component and remember which properties
  they override). The editor and the MCP server run the same code, so agent edits behave exactly like manual ones.
- The editor measures text with real fonts; the MCP server uses an estimate and the editor corrects text sizes the
  next time the file is open.

## Not implemented

Variables and modes, component properties (beyond variants and overrides), instances that follow a component on
another page, interactive components, scrolling / fixed layers in prototypes, plugins, Dev Mode annotations,
branching, team libraries, and authentication (the local backend is open to anything that can reach it).
