import { fontString, type MeasureFn } from '../../shared/text'

export const FONTS = [
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Raleway',
  'Nunito',
  'Manrope',
  'DM Sans',
  'Work Sans',
  'Space Grotesk',
  'Source Sans 3',
  'IBM Plex Sans',
  'Oswald',
  'Bebas Neue',
  'Playfair Display',
  'Merriweather',
  'Lora',
  'DM Serif Display',
  'Roboto Mono',
  'JetBrains Mono',
  'IBM Plex Mono',
  'Pacifico',
  'Caveat',
  'Arial',
  'Georgia',
  'Times New Roman',
  'Courier New',
]
const SYSTEM = new Set(['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Helvetica', 'Verdana'])

const sheets = new Map<string, Promise<void>>([['Inter', Promise.resolve()]])
const faces = new Set<string>()
let pending = 0
const listeners = new Set<() => void>()
const onChange = () => listeners.forEach((fn) => fn())

export const fontsPending = () => pending > 0
export function onFontsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Make sure a Google font (family + weight) is loaded; triggers a re-layout when it arrives. */
export function ensureFont(family: string, weight = 400, italic = false) {
  if (SYSTEM.has(family)) return
  const key = `${family}:${weight}:${italic}`
  if (faces.has(key)) return
  faces.add(key)
  let sheet = sheets.get(family)
  if (!sheet) {
    sheet = new Promise<void>((resolve) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}:100,200,300,400,500,600,700,800,900,100i,300i,400i,500i,600i,700i,900i&display=swap`
      link.onload = () => resolve()
      link.onerror = () => resolve()
      document.head.appendChild(link)
    })
    sheets.set(family, sheet)
  }
  pending++
  sheet
    .then(() => document.fonts.load(`${italic ? 'italic ' : ''}${weight} 16px "${family}"`))
    .catch(() => {})
    .finally(() => {
      pending--
      cache.clear()
      onChange()
    })
}

const ctx = document.createElement('canvas').getContext('2d')!
const cache = new Map<string, number>()

export const measureText: MeasureFn = (text, n) => {
  if (!text) return 0
  const font = fontString(n)
  const ls = n.letterSpacing ?? 0
  const key = font + '|' + ls + '|' + text
  let w = cache.get(key)
  if (w === undefined) {
    ctx.font = font
    ;(ctx as unknown as { letterSpacing: string }).letterSpacing = ls + 'px'
    w = ctx.measureText(text).width
    if (cache.size > 30000) cache.clear()
    cache.set(key, w)
  }
  return w
}
