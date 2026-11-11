// Entry point of the bundle that runs inside the QuickJS sandbox (built into sandbox.generated.ts by
// scripts/build-sandbox.mjs). Everything here executes without access to Node, the network or the host process:
// it receives the file's pages as JSON, runs the script against the Plugin API shim, and returns JSON.
import { runFigmaCodeInline } from './figmaApi'

const g = globalThis as Record<string, unknown>

// xorshift128+, seeded by the host for each run (QuickJS has no crypto).
let s0 = 0x9e3779b9
let s1 = 0x243f6a88
const next = () => {
  let a = s0
  const b = s1
  s0 = b
  a ^= a << 23
  a ^= a >>> 17
  a ^= b ^ (b >>> 26)
  s1 = a
  return (a + b) >>> 0
}
g.crypto = {
  getRandomValues: (a: Uint8Array | Uint32Array) => {
    for (let i = 0; i < a.length; i++) a[i] = next()
    return a
  },
}
g.structuredClone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

// Timers run as soon as the current job finishes: there is no clock to wait on inside the sandbox.
let timerId = 0
const cancelled = new Set<number>()
g.setTimeout = (fn: () => void) => {
  const id = ++timerId
  void Promise.resolve().then(() => (cancelled.delete(id) ? undefined : fn()))
  return id
}
g.clearTimeout = (id: number) => void cancelled.add(id)

g.__run = async (input: string) => {
  const i = JSON.parse(input)
  s0 = (i.seed[0] >>> 0) || 1
  s1 = (i.seed[1] >>> 0) || 2
  const run = await runFigmaCodeInline(i.code, i.pages, i.currentPageId, i.styles, i.fileName)
  return JSON.stringify({ run, pages: i.pages, styles: i.styles })
}
