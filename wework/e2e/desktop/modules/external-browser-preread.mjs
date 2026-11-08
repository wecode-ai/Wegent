import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const RUNTIME_DIRECTORIES = ['/opt/google/chrome', '/opt/wegent-e2e/chromedriver']
const BINARIES = RUNTIME_DIRECTORIES.map((directory, index) =>
  join(directory, index === 0 ? 'chrome' : 'chromedriver')
)

export function dependencyPaths(output) {
  assert.doesNotMatch(output, /=>\s+not found/, 'Browser runtime dependency is missing')
  return output.split('\n').flatMap(line => {
    const path = line.match(/^\s*(?:\S+\s+=>\s+)?(\/\S+)\s+\(/)?.[1]
    return path ? [path] : []
  })
}

export async function runtimeFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await runtimeFiles(path)))
    else if (entry.isFile()) files.push(path)
    // Do not follow links into profiles or unrelated host directories.
  }
  return files
}

export async function preReadFiles(paths) {
  const started = performance.now()
  const files = new Set(await Promise.all(paths.map(path => realpath(path))))
  const buffer = Buffer.alloc(1024 * 1024)
  let bytes = 0
  for (const path of files) {
    assert.ok((await stat(path)).isFile(), 'Pre-read target must be a regular file')
    const file = await open(path, 'r')
    try {
      assert.ok((await file.stat()).isFile(), 'Pre-read target must be a regular file')
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        bytes += bytesRead
      }
    } finally {
      await file.close()
    }
  }
  return {
    files: files.size,
    bytes,
    elapsedMs: Math.round(performance.now() - started),
  }
}

export async function preReadBrowserRuntime(enabled) {
  if (!enabled) return null
  const started = performance.now()
  const files = []
  for (const directory of RUNTIME_DIRECTORIES) files.push(...(await runtimeFiles(directory)))
  for (const binary of BINARIES) {
    const { stdout } = await execute('ldd', [binary])
    files.push(...dependencyPaths(stdout))
  }
  const result = await preReadFiles(files)
  return {
    experiment: 'external-browser-read-only-preread',
    ...result,
    preparationMs: Math.round(performance.now() - started),
  }
}
