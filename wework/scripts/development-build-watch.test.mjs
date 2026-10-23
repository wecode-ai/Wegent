import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, vi } from 'vitest'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

vi.mock('node:fs', async importOriginal => {
  const filesystem = await importOriginal()
  return { ...filesystem, watch: vi.fn(filesystem.watch) }
})

test.each(['checkout', 'dist/checkout', '.git/worktrees/checkout', 'node_modules/checkout'])(
  'builds changes under %s, recovers from failure, and ignores output',
  async checkout => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'development-build-watch-'))
    const root = path.join(temporary, checkout)
    await mkdir(root, { recursive: true })
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
    let change
    const close = vi.fn()
    vi.mocked(watch).mockImplementationOnce((_directory, _options, listener) => {
      change = listener
      return { on: vi.fn(), close }
    })
    // Exercise debounce and filtering independently of native event delivery latency.
    vi.useFakeTimers()
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
      change('change', 'entry.js')
      await vi.advanceTimersByTimeAsync(20)
      await expect(build.mock.results.at(-1).value).rejects.toThrow('compile failed')
      expect(onError).toHaveBeenCalledOnce()
      expect(published).toBe('one')
      await writeFile(source, 'two')
      change('change', 'entry.js')
      await vi.advanceTimersByTimeAsync(20)
      await build.mock.results.at(-1).value
      expect(published).toBe('two')
      for (const filename of ['output/bundle.js', 'dist/bundle.js', '.git/index', 'node_modules/a'])
        change('change', filename)
      await vi.advanceTimersByTimeAsync(20)
      expect(build).toHaveBeenCalledTimes(3)
    } finally {
      await watcher.close()
      expect(close).toHaveBeenCalledOnce()
      vi.useRealTimers()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test('rebuilds unchanged CSS assets and publishes subsequent asset edits with fresh Vite instances', async () => {
  const { build: viteBuild } = await import('vite')
  const { readdir } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wework-css-build-')))
  const output = path.join(root, 'output')
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/entry.js"></script>')
  await writeFile(path.join(root, 'entry.js'), 'import "./style.css"; console.log("one")')
  await writeFile(path.join(root, 'style.css'), 'body { background: url("./image.svg") }')
  const svg = color =>
    `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="10" height="10"/></svg>`
  await writeFile(path.join(root, 'image.svg'), svg('red'))
  let completed = 0
  const onError = vi.fn()
  const watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    ignored: [output],
    debounceMs: 20,
    onError,
    build: async () => {
      await viteBuild({
        root,
        configFile: false,
        logLevel: 'silent',
        build: { outDir: output, emptyOutDir: false, assetsInlineLimit: 0 },
      })
      completed += 1
    },
  })
  try {
    await writeFile(path.join(root, 'entry.js'), 'import "./style.css"; console.log("two")')
    await expect.poll(() => completed, { timeout: 10000 }).toBe(2)
    await writeFile(path.join(root, 'image.svg'), svg('blue'))
    await expect.poll(() => completed, { timeout: 10000 }).toBe(3)
    expect(onError).not.toHaveBeenCalled()
    expect(
      (await readdir(path.join(output, 'assets'))).filter(file => file.endsWith('.svg'))
    ).toHaveLength(2)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
