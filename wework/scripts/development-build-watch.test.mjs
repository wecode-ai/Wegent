import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, vi } from 'vitest'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

test('builds source changes serially, recovers from failure, and ignores its output directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-build-watch-'))
  const output = path.join(root, 'output')
  await mkdir(output)
  const source = path.join(root, 'entry.js')
  await writeFile(source, 'one')
  let published = ''
  const onError = vi.fn()
  const build = vi.fn(async () => {
    const snapshot = await readFile(source, 'utf8')
    if (snapshot === 'invalid') throw new Error('compile failed')
    published = snapshot
    await writeFile(path.join(output, 'bundle.js'), snapshot)
  })
  const watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    ignored: [output],
    build,
    onError,
    debounceMs: 20,
  })
  try {
    expect(published).toBe('one')
    await writeFile(source, 'invalid')
    await expect.poll(() => onError.mock.calls.length).toBe(1)
    expect(published).toBe('one')
    await writeFile(source, 'two')
    await expect.poll(() => published).toBe('two')
    expect(build).toHaveBeenCalledTimes(3)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
})
