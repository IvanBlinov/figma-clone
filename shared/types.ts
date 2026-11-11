// Scene model shared by the editor, the Convex backend and the MCP server.

export type NodeType = 'FRAME' | 'GROUP' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'VECTOR' | 'TEXT'

export interface GradientStop {
  position: number // 0..1
  color: string // #RRGGBB
  opacity?: number // 0..1
}

export type Paint =
  | { type: 'SOLID'; color: string; opacity?: number; visible?: boolean }
  | {
      type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'
      stops: GradientStop[]
      angle?: number // degrees, 0 = left→right, 90 = top→bottom (linear only)
      opacity?: number
      visible?: boolean
    }
  | { type: 'IMAGE'; url: string; scaleMode?: 'FILL' | 'FIT' | 'STRETCH'; opacity?: number; visible?: boolean }
  // `url` is an MP4/WebM file; `posterUrl` is a still of its first frame (shown until the video loads, and used by exports).
  | { type: 'VIDEO'; url: string; posterUrl?: string; scaleMode?: 'FILL' | 'FIT' | 'STRETCH'; opacity?: number; visible?: boolean }

export type Effect =
  | {
      type: 'DROP_SHADOW' | 'INNER_SHADOW'
      color: string
      opacity?: number
      x: number
      y: number
      blur: number
      spread?: number
      visible?: boolean
    }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number; visible?: boolean }

export type Sizing = 'FIXED' | 'HUG' | 'FILL'

/** Per-range style overrides inside a text node (mixed styles). Ranges are [start, end) offsets into `characters`. */
export interface TextRunStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  italic?: boolean
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
  letterSpacing?: number
  fills?: Paint[]
}
export interface TextRun {
  start: number
  end: number
  style: TextRunStyle
}

export type Constraint = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE'
export interface Constraints {
  horizontal?: Constraint
  vertical?: Constraint
}

/** Prototype interaction. */
export interface Reaction {
  trigger: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'AFTER_TIMEOUT'
  action: 'NAVIGATE' | 'OVERLAY' | 'CLOSE_OVERLAY' | 'BACK' | 'URL'
  destinationId?: string
  url?: string
  transition?: 'INSTANT' | 'DISSOLVE' | 'SMART_ANIMATE' | 'MOVE_IN' | 'PUSH' | 'SLIDE_IN'
  direction?: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM'
  duration?: number // ms
  easing?: 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT'
  timeout?: number // ms, AFTER_TIMEOUT only
}

/** Prototype device: the screen size a prototype is presented at (page setting). Frames larger than it scroll. */
export interface PrototypeDevice {
  name?: string
  width: number
  height: number
}

export type OverlayPosition = 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT'
export type OverlayBackground = { type: 'NONE' } | { type: 'SOLID_COLOR'; color: string; opacity?: number }

export interface LayoutGrid {
  pattern: 'GRID' | 'COLUMNS' | 'ROWS'
  size?: number // GRID: cell size
  count?: number // COLUMNS / ROWS
  gutter?: number
  margin?: number
  color?: string
  opacity?: number
  visible?: boolean
}

export type BooleanOp = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE'

export interface SceneNode {
  id: string
  parentId?: string // undefined = direct child of the page
  order: number // z-order / auto-layout order among siblings (ascending = back → front)
  type: NodeType
  name: string
  // Geometry is relative to the parent. Rotation is in degrees, clockwise, around the top-left corner.
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  opacity?: number
  visible?: boolean
  locked?: boolean
  blendMode?: string
  fills?: Paint[]
  strokes?: Paint[]
  strokeWeight?: number
  strokeAlign?: 'INSIDE' | 'CENTER' | 'OUTSIDE'
  dashPattern?: number[]
  strokeCap?: 'NONE' | 'ROUND' | 'SQUARE'
  cornerRadius?: number
  cornerRadii?: [number, number, number, number] // tl, tr, br, bl
  effects?: Effect[]
  // Frames
  clipsContent?: boolean
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX'
  // Any node (meaningful inside auto-layout parents, and on auto-layout frames themselves)
  layoutSizingHorizontal?: Sizing
  layoutSizingVertical?: Sizing
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  // Text
  characters?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  italic?: boolean
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM'
  lineHeight?: number // px; undefined = auto
  letterSpacing?: number // px
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT'
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
  // Polygon / star
  pointCount?: number
  starInnerRadius?: number // 0..1
  // Vector: SVG path data in a vectorWidth × vectorHeight box, scaled to width × height
  vectorPath?: string
  vectorWidth?: number
  vectorHeight?: number
  vectorFillRule?: 'nonzero' | 'evenodd'
  // Lines
  arrowStart?: boolean
  arrowEnd?: boolean
  // Text: mixed styles
  textRuns?: TextRun[]
  // Resizing behaviour inside a (non auto-layout) frame
  constraints?: Constraints
  constrainProportions?: boolean
  // Auto layout extras
  layoutWrap?: boolean
  counterAxisSpacing?: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  layoutGrids?: LayoutGrid[]
  // Components: a FRAME with isComponent is a main component; a FRAME with componentId is an instance of it.
  // Nodes inside an instance mirror the component's nodes (sourceId) and list the props they override.
  isComponent?: boolean
  isComponentSet?: boolean
  // A FRAME with isSection is a section: it never clips, has no auto layout, and shows its name above its corner at any depth.
  isSection?: boolean
  description?: string
  componentId?: string
  sourceId?: string
  overrides?: string[]
  // A GROUP with booleanOp renders as the boolean combination of its children.
  booleanOp?: BooleanOp
  // A mask clips the siblings above it to its outline.
  isMask?: boolean
  // Prototyping
  reactions?: Reaction[]
  flowStart?: string
  /** FRAME: which way its content scrolls in a prototype when it is larger than the frame. Top-level frames taller or wider than the device scroll unless this is NONE. */
  overflowDirection?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH'
  /** Direct child of a scrolling frame: FIXED stays put while the rest scrolls (a tab bar, a header). Placement follows its constraints, so a bottom-constrained layer sticks to the bottom of the device. */
  scrollBehavior?: 'SCROLLS' | 'FIXED'
  /** Top-level FRAME opened as an overlay: where it appears, what is drawn behind it, and whether a click outside closes it. */
  overlayPositionType?: OverlayPosition
  overlayBackground?: OverlayBackground
  overlayBackgroundInteraction?: 'NONE' | 'CLOSE_ON_CLICK_OUTSIDE'
  // Shared styles (see the `styles` table)
  fillStyleId?: string
  strokeStyleId?: string
  textStyleId?: string
  effectStyleId?: string
  // Data a script stored on the layer (Plugin API getPluginData / getSharedPluginData). Never copied to instances.
  pluginData?: Record<string, string>
  sharedPluginData?: Record<string, Record<string, string>>
}

export type Op =
  | { op: 'create'; node: SceneNode }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'delete'; id: string }

export const CONTAINER_TYPES: NodeType[] = ['FRAME', 'GROUP']
export const isContainer = (n: { type: NodeType }) => n.type === 'FRAME' || n.type === 'GROUP'
export const isAutoLayout = (n: SceneNode) => n.type === 'FRAME' && !!n.layoutMode && n.layoutMode !== 'NONE'

export function newId(): string {
  const a = new Uint8Array(9)
  globalThis.crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]
  return s
}

const TYPE_LABEL: Record<NodeType, string> = {
  FRAME: 'Frame',
  GROUP: 'Group',
  RECTANGLE: 'Rectangle',
  ELLIPSE: 'Ellipse',
  LINE: 'Line',
  POLYGON: 'Polygon',
  STAR: 'Star',
  VECTOR: 'Vector',
  TEXT: 'Text',
}
export const typeLabel = (t: NodeType) => TYPE_LABEL[t]

const BOOL_LABEL: Record<BooleanOp, string> = { UNION: 'Union', SUBTRACT: 'Subtract', INTERSECT: 'Intersect', EXCLUDE: 'Exclude' }
/** Human label that accounts for components, instances and boolean groups. */
export function nodeLabel(n: SceneNode): string {
  if (n.isComponentSet) return 'Component set'
  if (n.isComponent) return 'Component'
  if (n.componentId) return 'Instance'
  if (n.isSection) return 'Section'
  if (n.booleanOp) return BOOL_LABEL[n.booleanOp]
  if (n.isMask) return 'Mask'
  if (n.type === 'LINE' && (n.arrowEnd || n.arrowStart)) return 'Arrow'
  return TYPE_LABEL[n.type]
}
export const isSection = (n: SceneNode) => n.type === 'FRAME' && !!n.isSection
/** Properties of a freshly created section (on top of type FRAME). */
export function sectionDefaults(): Partial<SceneNode> {
  return { isSection: true, clipsContent: false, fills: [{ type: 'SOLID', color: '#F5F5F5' }], strokes: [], cornerRadius: 2 }
}
/** Flat colour standing in for a video that has no poster (exports, CSS, swatches). */
export const VIDEO_FALLBACK = '#1F1F1F'
export const inInstance = (n: SceneNode) => !!n.componentId || !!n.sourceId

/** Defaults applied when a node of a given type is created (by tools or by agents). */
export function defaultsFor(type: NodeType): Partial<SceneNode> {
  switch (type) {
    case 'FRAME':
      return { fills: [{ type: 'SOLID', color: '#FFFFFF' }], clipsContent: true }
    case 'GROUP':
      return {}
    case 'LINE':
      return { strokes: [{ type: 'SOLID', color: '#000000' }], strokeWeight: 1, strokeAlign: 'CENTER', height: 0 }
    case 'VECTOR':
      return { strokes: [{ type: 'SOLID', color: '#000000' }], strokeWeight: 1, strokeAlign: 'CENTER' }
    case 'TEXT':
      return {
        fills: [{ type: 'SOLID', color: '#000000' }],
        characters: '',
        fontSize: 12,
        fontFamily: 'Inter',
        fontWeight: 400,
        textAlignHorizontal: 'LEFT',
        textAlignVertical: 'TOP',
        textAutoResize: 'WIDTH_AND_HEIGHT',
      }
    case 'POLYGON':
      return { fills: [{ type: 'SOLID', color: '#D9D9D9' }], pointCount: 3 }
    case 'STAR':
      return { fills: [{ type: 'SOLID', color: '#D9D9D9' }], pointCount: 5, starInnerRadius: 0.382 }
    default:
      return { fills: [{ type: 'SOLID', color: '#D9D9D9' }] }
  }
}
