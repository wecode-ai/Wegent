import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import chokidar from 'chokidar'
import { test, expect, vi, onTestFinished, onTestFailed } from 'vitest'
import { watchDevelopmentBuild, watchDevelopmentDirectory } from './lib/development-build-watch.mjs'

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
    const events = []
    const record = (...event) => events.push({ time: Date.now(), event })
    onTestFailed(() => console.error(JSON.stringify({ checkout, events }, null, 2)))
    const failedBuild = Promise.withResolvers()
    const recoveredBuild = Promise.withResolvers()
    const onError = vi.fn(error => {
      record('build-error', error.message)
      failedBuild.resolve(error)
    })
    const build = vi.fn(async () => {
      const snapshot = await readFile(source, 'utf8')
      record('build', snapshot)
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
      watchDirectory: (directory, options, notify) =>
        watchDevelopmentDirectory(
          directory,
          options,
          (...event) => {
            record('native-notification', ...event)
            notify(...event)
          },
          (directory, options) =>
            chokidar.watch(directory, { ...options, useFsEvents: false, usePolling: false })
        ),
    })
    onTestFinished(async () => {
      await watcher.close()
      await rm(temporary, { recursive: true, force: true })
    })
    expect(published).toBe('one')
    record('write-invalid')
    await writeFile(source, 'invalid')
    // Await native build callbacks under Vitest's test deadline, with cleanup
    // registered separately so a missing notification cannot leak the watcher.
    expect(await failedBuild.promise).toEqual(new Error('compile failed'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(published).toBe('one')
    record('write-recovery')
    await writeFile(source, 'two')
    await recoveredBuild.promise
    expect(published).toBe('two')
    expect(build).toHaveBeenCalledTimes(3)
  }
)

test('starts the initial build only after directory subscriptions are ready', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-build-ready-'))
  const readiness = Promise.withResolvers()
  const build = vi.fn()
  const close = vi.fn()
  const onError = vi.fn()
  let notify
  const starting = watchDevelopmentBuild({
    directories: [root],
    files: [],
    build,
    onError,
    watchDirectory: (_directory, _options, callback) => {
      notify = callback
      return { ready: readiness.promise, on: vi.fn(), close }
    },
  })
  notify('change', 'entry.js')
  notify('change', undefined)
  expect(build).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  readiness.resolve()
  const watcher = await starting
  try {
    expect(build).toHaveBeenCalledTimes(1)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
  expect(close).toHaveBeenCalledTimes(1)
})

test.each(['directory', 'file', 'fsevents'])(
  'preserves a rapid recovery edit omitted by normalized events from a watched %s',
  async watchedKind => {
    const root = await mkdtemp(path.join(tmpdir(), 'development-build-raw-'))
    const source = path.join(root, 'entry.js')
    await writeFile(source, 'one')
    const native = new EventEmitter()
    native.close = vi.fn()
    const failed = Promise.withResolvers()
    let published
    const onError = vi.fn(error => failed.resolve(error))
    const build = vi.fn(async () => {
      const value = await readFile(source, 'utf8')
      if (value === 'invalid') throw new Error('compile failed')
      published = value
    })
    const watcher = await watchDevelopmentBuild({
      directories: [root],
      files: [],
      build,
      onError,
      debounceMs: 0,
      watchDirectory: (directory, options, notify) =>
        watchDevelopmentDirectory(directory, options, notify, () => {
          queueMicrotask(() => native.emit('ready'))
          return native
        }),
    })
    onTestFinished(async () => {
      await watcher.close()
      await rm(root, { recursive: true, force: true })
    })
    const details =
      watchedKind === 'fsevents' ? {} : { watchedPath: watchedKind === 'file' ? source : root }
    const filename = watchedKind === 'fsevents' ? await realpath(source) : 'entry.js'
    await writeFile(source, 'invalid')
    native.emit('all', 'change', source)
    native.emit('raw', 'change', filename, details)
    expect(await failed.promise).toEqual(new Error('compile failed'))
    await writeFile(source, 'two')
    // The second normalized change is suppressed by the Node backend's throttle.
    native.emit('raw', 'change', filename, details)
    native.emit('raw', 'change', filename, details)
    await expect.poll(() => published).toBe('two')
    expect(build).toHaveBeenCalledTimes(3)
    expect(onError).toHaveBeenCalledTimes(1)
  }
)

test('accepts canonical raw paths only inside the subscribed directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-build-boundary-'))
  const native = new EventEmitter()
  native.close = vi.fn()
  const notify = vi.fn()
  const watcher = watchDevelopmentDirectory(root, { recursive: true }, notify, () => native)
  native.emit('ready')
  await watcher.ready
  try {
    const outside = path.join(`${root}-outside`, 'entry.js')
    native.emit('raw', 'change', outside, {})
    native.emit('raw', 'change', 'entry.js', { watchedPath: path.dirname(outside) })
    native.emit('raw', 'change', 'entry.js', {})
    expect(notify).not.toHaveBeenCalled()
    native.emit('raw', 'change', path.join(await realpath(root), 'entry.js'), {})
    expect(notify).toHaveBeenCalledExactlyOnceWith('change', 'entry.js')
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
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
