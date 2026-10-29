import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Shared runners consume build artifacts without installing workspace packages. */
export async function extractRuntimeArchive(archive, destination) {
  // Keep native paths in Node: GNU tar parses drive letters as remote hosts
  // and unquotes backslash escapes in extraction directory arguments.
  const extraction = execute('tar', ['-xzf', '-'], {
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
}
