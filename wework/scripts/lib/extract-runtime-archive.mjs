import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function runtimeArchiveExecutable() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable')
    return join(systemRoot, 'System32', 'tar.exe')
  }
  return 'tar'
}

/** Shared runners consume build artifacts without installing workspace packages. */
export async function extractRuntimeArchive(archive, destination) {
  const executable = runtimeArchiveExecutable()
  // Keep native paths in Node: GNU tar parses drive letters as remote hosts
  // and unquotes backslash escapes in extraction directory arguments.
  const started = performance.now()
  const extraction = execute(executable, ['-xzf', '-'], {
    cwd: resolve(destination),
    timeout: 300_000,
    windowsHide: true,
  })
  const operations = [extraction]
  if (extraction.child.stdin)
    operations.push(pipeline(createReadStream(archive), extraction.child.stdin))
  const results = await Promise.allSettled(operations)
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Runtime archive extraction failed')
  console.log(
    JSON.stringify({
      event: 'input-archive-extracted',
      executable,
      elapsedMs: Math.round(performance.now() - started),
    })
  )
}
