// Fonts for PNG export. Inter ships with the server, because hosted environments have no fonts installed
// (and most desktops lack Inter, the default family). Other families still come from the system when present.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FONTS } from './fonts.generated'

let files: string[] | null = null

export function fontOptions() {
  if (!files) {
    files = []
    try {
      const dir = join(tmpdir(), 'figma-clone-fonts')
      mkdirSync(dir, { recursive: true })
      for (const [name, base64] of Object.entries(FONTS)) {
        const path = join(dir, name)
        if (!existsSync(path)) writeFileSync(path, Buffer.from(base64, 'base64'))
        files.push(path)
      }
    } catch {
      files = []
    }
  }
  return { loadSystemFonts: true, fontFiles: files, defaultFontFamily: files.length ? 'Inter' : 'Arial' }
}
