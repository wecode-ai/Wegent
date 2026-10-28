import { EventEmitter } from 'node:events'
import { appendFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, onTestFailed, onTestFinished, test, vi } from 'vitest'

const { watch } = vi.hoisted(() => ({ watch: vi.fn() }))
vi.mock('chokidar', () => ({ watch }))
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

let temporary
let observers

beforeEach(async () => {
  vi.useFakeTimers()
  temporary = await mkdtemp(path.join(tmpdir(), 'development-watch-lifecycle-'))
  observers = []
  watch.mockImplementation((directory, options) => {
    const observer = new EventEmitter()
    observer.close = vi.fn(async () => {})
    observers.push({ directory, options, observer })
    return observer
  })
})

afterEach(async () => {
  vi.useRealTimers()
  watch.mockReset()
  await rm(temporary, { recursive: true, force: true })
})

test('waits for every observer before the initial build and reads edits made during readiness', async () => {
  const first = path.join(temporary, 'first')
  const second = path.join(temporary, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const source = path.join(first, 'entry.js')
  await writeFile(source, 'before readiness')
  const snapshots = []
  const build = vi.fn(async () => {
    snapshots.push(await readFile(source, 'utf8'))
  })
  const watcherReady = watchDevelopmentBuild({
    directories: [first, second],
    files: [],
    build,
    onError: vi.fn(),
  })
  expect(build).not.toHaveBeenCalled()
  observers[0].observer.emit('ready')
  await writeFile(source, 'during readiness')
  observers[0].observer.emit('all', 'change', source)
  expect(build).not.toHaveBeenCalled()
  observers[1].observer.emit('ready')
  const watcher = await watcherReady
  try {
    expect(build).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual(['during readiness'])
    observers[0].observer.emit('all', 'change', source)
    await vi.advanceTimersByTimeAsync(350)
    expect(build).toHaveBeenCalledTimes(1)
  } finally {
    await watcher.close()
  }
})

test('rejects readiness errors once and waits for all observers to close', async () => {
  const second = path.join(temporary, 'second')
  await mkdir(second)
  const closeGate = Promise.withResolvers()
  const build = vi.fn()
  const onError = vi.fn()
  const error = new Error('watch subscription failed')
  const pending = watchDevelopmentBuild({
    directories: [temporary, second],
    files: [],
    build,
    onError,
  })
  const rejected = expect(pending).rejects.toBe(error)
  observers[0].observer.close.mockReturnValue(closeGate.promise)
  let settled = false
  pending
    .catch(() => {})
    .finally(() => {
      settled = true
    })
  try {
    observers[0].observer.emit('error', error)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(observers[0].observer.close).toHaveBeenCalledTimes(1)
    expect(observers[1].observer.close).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    expect(build).not.toHaveBeenCalled()
  } finally {
    closeGate.resolve()
    await rejected
  }
})

test('closes ready observers when the initial build rejects', async () => {
  const error = new Error('initial compilation failed')
  const onError = vi.fn()
  const pending = watchDevelopmentBuild({
    directories: [temporary],
    files: [],
    build: vi.fn().mockRejectedValue(error),
    onError,
  })
  const rejected = expect(pending).rejects.toBe(error)
  observers[0].observer.emit('ready')
  await rejected
  expect(onError).not.toHaveBeenCalled()
  expect(observers[0].observer.close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('close waits for a running build and discards a queued follow-up build', async () => {
  const source = path.join(temporary, 'entry.js')
  await writeFile(source, 'one')
  const buildGate = Promise.withResolvers()
  const build = vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(buildGate.promise)
  const ready = watchDevelopmentBuild({
    directories: [temporary],
    files: [],
    build,
    onError: vi.fn(),
    debounceMs: 20,
  })
  observers[0].observer.emit('ready')
  const watcher = await ready
  try {
    await writeFile(source, 'second input')
    observers[0].observer.emit('all', 'change', source)
    await vi.advanceTimersByTimeAsync(20)
    expect(build).toHaveBeenCalledTimes(2)
    await writeFile(source, 'third queued input')
    observers[0].observer.emit('all', 'change', source)
    await vi.advanceTimersByTimeAsync(20)
    let settled = false
    const closing = watcher.close().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(observers[0].observer.close).toHaveBeenCalledTimes(1)
    buildGate.resolve()
    await closing
    await vi.advanceTimersByTimeAsync(100)
    expect(build).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    buildGate.resolve()
    await watcher.close()
  }
})

test('ignores generated output and unrelated siblings of explicitly watched files', async () => {
  const root = path.join(temporary, 'dist', 'checkout')
  const output = path.join(root, 'output')
  await mkdir(output, { recursive: true })
  const configuration = path.join(temporary, 'config.js')
  await writeFile(configuration, 'first')
  const build = vi.fn(async () => {})
  const ready = watchDevelopmentBuild({
    directories: [root],
    files: [configuration],
    ignored: [output],
    build,
    onError: vi.fn(),
    debounceMs: 20,
  })
  for (const { observer } of observers) observer.emit('ready')
  const watcher = await ready
  try {
    expect(observers[0].options.ignored(root)).toBe(false)
    expect(observers[0].options.ignored(path.join(output, 'bundle.js'))).toBe(true)
    expect(observers[0].options.ignored(path.join(root, 'node_modules', 'dependency.js'))).toBe(
      true
    )
    expect(observers[0].options.disableGlobbing).toBe(true)
    expect(observers[1].options.depth).toBe(0)
    await writeFile(path.join(output, 'bundle.js'), 'generated')
    observers[0].observer.emit('all', 'change', path.join(output, 'bundle.js'))
    const sibling = path.join(temporary, 'unrelated.js')
    await writeFile(sibling, 'unrelated')
    observers[1].observer.emit('all', 'change', sibling)
    await vi.advanceTimersByTimeAsync(20)
    expect(build).toHaveBeenCalledTimes(1)
    await writeFile(configuration, 'changed configuration')
    observers[1].observer.emit('all', 'change', configuration)
    await vi.advanceTimersByTimeAsync(20)
    expect(build).toHaveBeenCalledTimes(2)
  } finally {
    await watcher.close()
  }
})

test('real close during live input changes waits for the active writer', async () => {
  vi.useRealTimers()
  const { watch: nativeWatch } = await vi.importActual('chokidar')
  const root = path.join(temporary, 'checkout')
  const output = path.join(root, 'output')
  const source = path.join(root, 'entry.js')
  await mkdir(output, { recursive: true })
  await writeFile(source, 'one')
  const nativeObservers = []
  const nextInputObserved = Promise.withResolvers()
  let observeNextInput = false
  let phase = 'starting'
  onTestFailed(() => console.error('[development-watch-real-close]', { phase }))
  watch.mockImplementation((directory, options) => {
    const observer = nativeWatch(directory, options)
    nativeObservers.push(observer)
    observer.on('raw', (_event, filename) => {
      if (observeNextInput && path.basename(filename) === 'entry.js' && statSync(source).size > 3) {
        nextInputObserved.resolve()
      }
    })
    return observer
  })
  const buildStarted = Promise.withResolvers()
  const writerGate = Promise.withResolvers()
  const onError = vi.fn()
  const build = vi.fn(async () => {
    const snapshot = await readFile(source, 'utf8')
    if (snapshot === 'two') {
      buildStarted.resolve()
      await writerGate.promise
    }
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
  let writing
  onTestFinished(async () => {
    clearInterval(writing)
    writerGate.resolve()
    await watcher.close()
  })
  try {
    phase = 'waiting-running-build'
    await writeFile(source, 'two')
    await buildStarted.promise
    observeNextInput = true
    writing = setInterval(() => appendFileSync(source, '.'), 1)
    phase = 'waiting-live-input-raw'
    await nextInputObserved.promise
    clearInterval(writing)
    let closed = false
    const closing = watcher.close().then(() => {
      closed = true
    })
    phase = 'waiting-observer-close'
    // Public, idempotent observer closure proves the writer still owns close's
    // remaining work. Internal input-stat timers are intentionally not asserted.
    await Promise.all(nativeObservers.map(observer => observer.close()))
    expect(closed).toBe(false)
    writerGate.resolve()
    phase = 'waiting-writer-close'
    await closing
    await writeFile(source, 'after close')
    expect(await readFile(path.join(output, 'bundle.js'), 'utf8')).toBe('two')
    expect(build).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  } finally {
    clearInterval(writing)
    writerGate.resolve()
    await watcher.close()
  }
})
