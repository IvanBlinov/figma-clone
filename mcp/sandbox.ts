// Runs use_figma scripts in QuickJS compiled to WebAssembly: a separate JavaScript engine with its own heap and no
// bindings to Node, the file system, the network or this process's environment. The script and the Plugin API shim
// both live inside it; only JSON crosses the boundary. That makes it safe to offer on the shared, hosted server.
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import { randomBytes } from 'node:crypto'
import type { PageModel, RunResult, StyleModel } from './figmaApi'
import { SANDBOX_SOURCE } from './sandbox.generated'

/** Long enough for a generator that builds a whole design system in one run (a few thousand layers). */
const TIME_LIMIT_MS = 90_000
const MEMORY_LIMIT = 256 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024

/**
 * Run `code` against copies of the pages and styles. On success `pages` and `styles` are updated in place with
 * what the script left behind; if the script throws, runs out of time or memory, nothing is changed.
 */
export async function runFigmaCode(code: string, pages: PageModel[], currentPageId: string, styles: StyleModel[], fileName: string): Promise<RunResult> {
  const input = JSON.stringify({ code, pages, currentPageId, styles, fileName, seed: [randomBytes(4).readUInt32LE(0), randomBytes(4).readUInt32LE(0)] })
  if (input.length > MAX_DOCUMENT_BYTES) throw new Error('This file is too large to script with use_figma; use create_nodes / update_nodes on the part you need')
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS))
  const vm = runtime.newContext()
  const fail = (handle: { dispose: () => void }): never => {
    const e = vm.dump(handle as never) as { name?: string; message?: string } | string
    handle.dispose()
    const message = typeof e === 'string' ? e : (e?.message ?? 'Script failed')
    if (/interrupted/i.test(message)) throw new Error(`Script timed out after ${TIME_LIMIT_MS / 1000}s`)
    if (/out of memory/i.test(message)) throw new Error('Script ran out of memory (256 MB)')
    throw new Error(typeof e === 'object' && e?.name && e.name !== 'Error' ? `${e.name}: ${message}` : message)
  }
  try {
    const loaded = vm.evalCode(SANDBOX_SOURCE, 'sandbox.js')
    if (loaded.error) fail(loaded.error)
    else loaded.value.dispose()
    const fn = vm.getProp(vm.global, '__run')
    const arg = vm.newString(input)
    const called = vm.callFunction(fn, vm.undefined, arg)
    fn.dispose()
    arg.dispose()
    if (called.error) fail(called.error)
    const promise = (called as { value: Parameters<typeof vm.resolvePromise>[0] }).value
    const settled = vm.resolvePromise(promise)
    promise.dispose()
    // Promises and timers inside the sandbox only advance while we run its job queue.
    const jobs = runtime.executePendingJobs()
    if (jobs.error) fail(jobs.error)
    const pending = Symbol('pending')
    const outcome = await Promise.race([settled, new Promise<typeof pending>((r) => setImmediate(() => r(pending)))])
    if (outcome === pending) throw new Error('Script never finished: it is waiting on a promise that does not resolve')
    if (outcome.error) fail(outcome.error)
    const value = (outcome as { value: Parameters<typeof vm.getString>[0] }).value
    const out = JSON.parse(vm.getString(value)) as { run: RunResult; pages: PageModel[]; styles: StyleModel[] }
    value.dispose()
    pages.splice(0, pages.length, ...out.pages)
    styles.splice(0, styles.length, ...out.styles)
    return out.run
  } finally {
    try {
      vm.dispose()
      runtime.dispose()
    } catch {
      // A script stopped mid-run can leave handles alive; the whole WebAssembly heap is dropped with the runtime anyway.
    }
  }
}
