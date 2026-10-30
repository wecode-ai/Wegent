import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, vi, onTestFailed, onTestFinished } from 'vitest'
import { watch } from 'node:fs'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

test('rebuilds input edits reported only as a directory-self notification', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-build-self-'))
  const source = path.join(root, 'entry.js')
  await writeFile(source, 'one')
  let notify
  const close = vi.fn()
  const watchDirectory = vi.fn((_directory, _options, callback) => {
    notify = callback
    return { on: vi.fn(), close }
  })
  let published
  const onError = vi.fn()
  const build = vi.fn(async () => {
    published = await readFile(source, 'utf8')
  })
  const watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    build,
    onError,
    debounceMs: 20,
    watchDirectory,
  })
  onTestFinished(async () => {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  })
  expect(published).toBe('one')
  await writeFile(source, 'two')
  notify('rename', path.basename(root))
  await expect.poll(() => published).toBe('two')
  expect(build).toHaveBeenCalledTimes(2)
  expect(watchDirectory).toHaveBeenCalledTimes(1)
  expect(onError).not.toHaveBeenCalled()
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
    const trace = []
    let nativeWatchReady = false
    const startedAt = performance.now()
    const record = event => trace.push({ elapsedMs: performance.now() - startedAt, ...event })
    onTestFailed(() => {
      process.stderr.write(`[development-build-watch] ${JSON.stringify({ checkout, trace })}\n`)
    })
    const failedBuild = Promise.withResolvers()
    const recoveredBuild = Promise.withResolvers()
    const onError = vi.fn(error => {
      record({ stage: 'build-error', message: error.message })
      failedBuild.resolve(error)
    })
    const build = vi.fn(async () => {
      const snapshot = await readFile(source, 'utf8')
      record({ stage: 'build', snapshot })
      if (snapshot === 'invalid') throw new Error('compile failed')
      published = snapshot
      await writeFile(path.join(output, 'bundle.js'), snapshot)
      if (snapshot === 'two') recoveredBuild.resolve()
    })
    const watcher = await watchDevelopmentBuild({
      directories: [root],
      files: [],
      ignored: [output],
      build,
      onError,
      debounceMs: 20,
      watchDirectory(directory, options, callback) {
        return watch(directory, options, (event, filename) => {
          nativeWatchReady = true
          record({ stage: 'native-event', event, filename: String(filename) })
          callback(event, filename)
        })
      },
    })
    onTestFinished(async () => {
      await watcher.close()
      await rm(temporary, { recursive: true, force: true })
    })
    expect(published).toBe('one')
    // macOS fs.watch can return before its native subscription is active:
    // https://github.com/nodejs/node/issues/52601
    // Probe ignored output until a native event acknowledges the subscription.
    let probe = 0
    await expect
      .poll(async () => {
        if (!nativeWatchReady) {
          await writeFile(path.join(output, '.watch-ready'), String(++probe))
        }
        return nativeWatchReady
      })
      .toBe(true)
    record({ stage: 'watch-ready', probes: probe })
    expect(build).toHaveBeenCalledTimes(1)
    record({ stage: 'write-invalid-started' })
    await writeFile(source, 'invalid')
    record({ stage: 'write-invalid-completed' })
    // Await native build callbacks under Vitest's test deadline, with cleanup
    // registered separately so a missing notification cannot leak the watcher.
    expect(await failedBuild.promise).toEqual(new Error('compile failed'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(published).toBe('one')
    record({ stage: 'write-recovery-started' })
    await writeFile(source, 'two')
    record({ stage: 'write-recovery-completed' })
    await recoveredBuild.promise
    expect(published).toBe('two')
    expect(build).toHaveBeenCalledTimes(3)
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
