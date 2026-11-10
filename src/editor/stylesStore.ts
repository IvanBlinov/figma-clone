// Shared styles (colour + text) of the open file. The Editor component keeps this in sync with Convex.
import { create } from 'zustand'
import type { Paint, SceneNode } from '../../shared/types'

export const TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontSize', 'italic', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase'] as const
export type TextStyleValue = Partial<Pick<SceneNode, (typeof TEXT_STYLE_KEYS)[number]>>

export interface StyleDoc {
  _id: string
  kind: 'PAINT' | 'TEXT'
  name: string
  value: { paints?: Paint[]; text?: TextStyleValue }
}

interface StylesState {
  styles: StyleDoc[]
  create: (kind: StyleDoc['kind'], name: string, value: StyleDoc['value']) => Promise<string>
  update: (id: string, patch: { name?: string; value?: StyleDoc['value'] }) => void
  remove: (id: string) => void
}

export const useStyles = create<StylesState>(() => ({
  styles: [],
  create: async () => '',
  update: () => {},
  remove: () => {},
}))

export const textStyleOf = (n: SceneNode): TextStyleValue => {
  const out: Record<string, unknown> = {}
  for (const k of TEXT_STYLE_KEYS) if (n[k] !== undefined) out[k] = n[k]
  return out as TextStyleValue
}
