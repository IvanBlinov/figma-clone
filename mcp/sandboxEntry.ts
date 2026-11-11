// Entry point of the bundle that runs inside the QuickJS sandbox (built into sandbox.generated.ts by
// scripts/build-sandbox.mjs). Everything here executes without access to Node, the network or the host process:
// it receives the file's pages as JSON, runs the script against the Plugin API shim, and returns JSON.
import { runFigmaCodeInline } from './figmaApi'

const g = globalThis as Record<string, unknown>

// xoshiro128**, a 32-bit generator, seeded by the host for each run (QuickJS has no crypto). Its low bits are as good
// as its high ones, which matters because ids take one byte per character. (A 32-bit cut of xorshift128+ repeated
// ids after a few hundred layers.)
const st = new Uint32Array(4)
const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k))
const next = () => {
  const r = Math.imul(rotl(Math.imul(st[1], 5), 7), 9) >>> 0
  const t = st[1] << 9
  st[2] ^= st[0]
  st[3] ^= st[1]
  st[1] ^= st[2]
  st[0] ^= st[3]
  st[2] ^= t
  st[3] = rotl(st[3], 11)
  return r
}
/** SplitMix32 spreads the two seed words over the whole state, so no word starts at zero. */
const seed = (a: number, b: number) => {
  let x = (a ^ Math.imul(b, 0x9e3779b9)) >>> 0
  for (let i = 0; i < 4; i++) {
    x = (x + 0x9e3779b9) >>> 0
    let z = x
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
    st[i] = (z ^ (z >>> 16)) >>> 0
  }
  if (!(st[0] | st[1] | st[2] | st[3])) st[0] = 1
}
seed(0x9e3779b9, 0x243f6a88)
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
  seed(i.seed[0] >>> 0, i.seed[1] >>> 0)
  const run = await runFigmaCodeInline(i.code, i.pages, i.currentPageId, i.styles, i.fileName)
  return JSON.stringify({ run, pages: i.pages, styles: i.styles })
}
