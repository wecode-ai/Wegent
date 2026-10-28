import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  isPluginDevelopmentSourceChange,
  PluginDevelopmentChildRuntime,
} from './plugin-development-child-runtime.js'

const { watchSource } = vi.hoisted(() => ({ watchSource: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: watchSource,
}))

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  watchSource.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(restart = vi.fn(async () => {})) {
  vi.useFakeTimers()
  const root = await mkdtemp(join(tmpdir(), 'plugin-reload-'))
  roots.push(root)
  const statePath = join(root, 'state.json')
  const sourceRoot = join(root, 'plugin')
  await mkdir(sourceRoot)
  const clientPath = join(sourceRoot, 'client.js')
  await writeFile(clientPath, 'export const version = 1')
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
  let notify!: (event: string, filename: string | null) => void
  watchSource.mockImplementation((_root, _options, listener) => {
    notify = listener
    return watcher
  })
  const runtime = new PluginDevelopmentChildRuntime({
    statePath,
    sourceRoot,
    focus: async () => {},
    openDevTools: () => {},
    restartCoreDsh: restart,
    requestStop: () => {},
    getCoreDshPid: () => 123,
    isShuttingDown: () => false,
  })
  runtime.startWatcher()
  const advance = () => vi.advanceTimersByTimeAsync(300)
  // Drain the serialized reload without depending on filesystem callback timing.
  const drain = () => (runtime as unknown as { reloadPromise: Promise<void> }).reloadPromise
  return {
    clientPath,
    sourceRoot,
    restart,
    change: (filename: string | null = 'client.js') => notify('change', filename),
    advance,
    drain,
    flush: async () => {
      await advance()
      await drain()
    },
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
  }
}

function heldReload() {
  let release!: () => void
  let started!: () => void
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const ready = new Promise<void>(resolve => {
    started = resolve
  })
  const restart = vi.fn(async () => {
    started()
    await hold
  })
  return { restart, ready, release }
}

describe('PluginDevelopmentChildRuntime', () => {
  test('ignores generated dependency and git changes', () => {
    expect(isPluginDevelopmentSourceChange('client.js')).toBe(true)
    expect(isPluginDevelopmentSourceChange(null)).toBe(true)
    expect(isPluginDevelopmentSourceChange('node_modules/dependency/index.js')).toBe(false)
    expect(isPluginDevelopmentSourceChange('.git/index')).toBe(false)
  })

  test('does not reload identical content for a delayed duplicate event during restart', async () => {
    const held = heldReload()
    const app = await fixture(held.restart)
    app.change()
    await app.advance()
    await held.ready

    app.change()
    await app.advance()
    held.release()
    await app.drain()

    expect(app.restart).toHaveBeenCalledTimes(1)
    expect(await app.state()).toMatchObject({ status: 'ready', hmrGeneration: 1 })
  })

  test('reloads a new content version that arrives during an in-flight restart', async () => {
    const held = heldReload()
    const app = await fixture(held.restart)
    app.change()
    await app.advance()
    await held.ready

    await writeFile(app.clientPath, 'export const version = 2')
    app.change()
    await app.advance()
    held.release()
    await app.drain()

    expect(app.restart).toHaveBeenCalledTimes(2)
    expect(await app.state()).toMatchObject({ status: 'ready', hmrGeneration: 2 })
  })

  test('ignores same-content rewrites but preserves later edits', async () => {
    const app = await fixture()
    app.change()
    await app.flush()
    await writeFile(app.clientPath, 'export const version = 1')
    app.change()
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(1)

    await writeFile(app.clientPath, 'export const version = 2')
    app.change()
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(2)
    expect(await app.state()).toMatchObject({ status: 'ready', hmrGeneration: 2 })
  })

  test('reloads deletion and recreation without repeating a deletion event', async () => {
    const app = await fixture()
    app.change()
    await app.flush()
    await rm(app.clientPath)
    app.change()
    await app.flush()
    app.change()
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(2)

    await writeFile(app.clientPath, 'export const version = 1')
    app.change()
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(3)
  })

  test('does not record failed content as successfully reloaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restart = vi.fn(async () => {}).mockRejectedValueOnce(new Error('reload rejected'))
    const app = await fixture(restart)
    app.change()
    await app.flush()
    expect(await app.state()).toMatchObject({ status: 'error', hmrGeneration: 0 })
    expect(error).toHaveBeenCalledWith('[plugin-development] hot reload failed', expect.any(Error))

    app.change()
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(2)
    expect(await app.state()).toMatchObject({ status: 'ready', hmrGeneration: 1 })
  })

  test('preserves reloads for unknown filenames and directory changes', async () => {
    const app = await fixture()
    app.change(null)
    await app.flush()
    app.change(null)
    await app.flush()
    await mkdir(join(app.sourceRoot, 'new-module'))
    app.change('new-module')
    await app.flush()
    expect(app.restart).toHaveBeenCalledTimes(3)
  })
})
