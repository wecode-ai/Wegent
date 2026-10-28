import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, vi, onTestFinished } from 'vitest'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

const checkouts = ['checkout', 'dist/checkout', '.git/worktrees/checkout', 'node_modules/checkout']

test.each(checkouts.flatMap(checkout => ['directory', 'file'].map(input => [checkout, input])))(
  'builds changes under %s with %s inputs, recovers from failure, and ignores output',
  async (checkout, input) => {
    const startedAt = Date.now()
    const phases = []
    const record = phase => {
      if (phases.length < 24) phases.push({ phase, elapsedMs: Date.now() - startedAt })
    }
    const temporary = await mkdtemp(path.join(tmpdir(), 'development-build-watch-'))
    const root = path.join(temporary, checkout)
    await mkdir(root, { recursive: true })
    const output = path.join(root, 'output')
    await mkdir(output)
    const source = path.join(root, 'entry.js')
    await writeFile(source, 'one')
    // Publish complete fixture versions: in-place writes expose a truncated file
    // before their promise resolves and can legitimately trigger extra builds.
    const saveSource = async value => {
      const staged = path.join(temporary, 'entry.next')
      await writeFile(staged, value)
      await rename(staged, source)
    }
    let published = ''
    const snapshots = []
    const failedBuild = Promise.withResolvers()
    const recoveredBuild = Promise.withResolvers()
    const onError = vi.fn(error => {
      record('failure-callback')
      failedBuild.resolve(error)
    })
    const build = vi.fn(async () => {
      const snapshot = await readFile(source, 'utf8')
      snapshots.push(snapshot)
      record(`build-read-${['one', 'invalid', 'two', ''].indexOf(snapshot)}`)
      if (snapshot === 'invalid') throw new Error('compile failed')
      published = snapshot
      await writeFile(path.join(output, 'bundle.js'), snapshot)
      if (snapshot === 'two') recoveredBuild.resolve()
    })
    const watcher = await watchDevelopmentBuild({
      directories: input === 'directory' ? [root] : [],
      files: input === 'file' ? [source] : [],
      ignored: [output],
      build,
      onError,
      debounceMs: 20,
    })
    record('watch-ready')
    onTestFinished(async () => {
      await watcher.close()
      await rm(temporary, { recursive: true, force: true })
      console.info('[development-build-watch-phases]', { checkout, input, phases })
    })
    expect(published).toBe('one')
    await saveSource('invalid')
    record('invalid-write-finished')
    // Await native build callbacks under Vitest's test deadline, with cleanup
    // registered separately so a missing notification cannot leak the watcher.
    expect(await failedBuild.promise).toEqual(new Error('compile failed'))
    record('failure-observed')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(published).toBe('one')
    await saveSource('two')
    record('recovery-write-finished')
    await recoveredBuild.promise
    record('recovery-observed')
    expect(published).toBe('two')
    expect(build).toHaveBeenCalledTimes(3)
    expect(snapshots).toEqual(['one', 'invalid', 'two'])
  }
)

test('observes new nested directories and their recreation', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'build-watch-directories-')))
  const nested = path.join(root, 'source', 'nested')
  const source = path.join(nested, 'entry.js')
  const snapshots = []
  const first = Promise.withResolvers()
  const removed = Promise.withResolvers()
  const restored = Promise.withResolvers()
  const onError = vi.fn()
  let watcher
  onTestFinished(async () => {
    await watcher?.close()
    await rm(root, { recursive: true, force: true })
  })
  watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    debounceMs: 20,
    onError,
    build: async () => {
      let snapshot
      try {
        snapshot = await readFile(source, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        snapshot = 'missing'
      }
      snapshots.push(snapshot)
      if (snapshot === 'one') first.resolve()
      if (snapshot === 'missing' && snapshots.length > 1) removed.resolve()
      if (snapshot === 'two') restored.resolve()
    },
  })
  await mkdir(nested, { recursive: true })
  await writeFile(source, 'one')
  await first.promise
  await rm(path.join(root, 'source'), { recursive: true })
  await removed.promise
  await mkdir(nested, { recursive: true })
  await writeFile(source, 'two')
  await restored.promise
  expect(snapshots).toEqual(['missing', 'one', 'missing', 'two'])
  expect(onError).not.toHaveBeenCalled()
})

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
