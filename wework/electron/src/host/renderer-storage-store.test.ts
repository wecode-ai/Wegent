import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererStorageStore } from './renderer-storage-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createStore(): Promise<{ root: string; store: RendererStorageStore }> {
  const root = await mkdtemp(join(tmpdir(), 'wework-renderer-storage-'))
  roots.push(root)
  return { root, store: new RendererStorageStore(root) }
}

describe('RendererStorageStore', () => {
  it('notifies login observers when a pending seed becomes durable through an unrelated update', async () => {
    const { root } = await createStore()
    const notify = vi.fn()
    const store = new RendererStorageStore(root, notify)
    const blocked = join(root, `renderer-local-storage.json.${process.pid}.tmp`)
    await mkdir(blocked)
    await store.initialize({ 'wework.cloudConnection': 'synthetic-session' })
    expect(notify).not.toHaveBeenCalled()
    await rm(blocked, { recursive: true })
    await store.update({ clear: false, changes: { appearance: 'dark' } })
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      clear: false,
      changes: { 'wework.cloudConnection': 'synthetic-session', appearance: 'dark' },
    })
  })

  it('preserves browser state when origin history cannot be read', async () => {
    const { root, store } = await createStore()
    await store.initialize({ credential: 'preserved' })
    const history = join(root, 'renderer-local-storage-origins.json')
    await mkdir(history)
    const cleanup = { clearAll: vi.fn(), clearOrigin: vi.fn() }
    await expect(store.prepareOrigin('http://127.0.0.1:4101', cleanup)).rejects.toMatchObject({
      path: history,
      code: expect.stringMatching(/EISDIR|EACCES|EPERM/),
    })
    expect(cleanup.clearAll).not.toHaveBeenCalled()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
    await expect(store.read()).resolves.toEqual({ credential: 'preserved' })
  })
  it('refuses a snapshot boundary until temporary initial state can be persisted', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    const blocked = `${path}.${process.pid}.tmp`
    await mkdir(blocked)
    await store.initialize({ credential: 'synthetic-temporary-account' })
    await expect(store.close()).rejects.toThrow()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists temporary state before closing when its write path is repaired', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    const blocked = `${path}.${process.pid}.tmp`
    await mkdir(blocked)
    const seed = { credential: 'synthetic-temporary-account' }
    await store.initialize(seed)
    await rm(blocked, { recursive: true })
    await store.close()
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toEqual(seed)
  })

  it('reports corrupt state during startup validation and closes without pending writes', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    await writeFile(path, '{invalid')
    await expect(store.initialize({})).resolves.toEqual({})
    await expect(store.validate()).rejects.toMatchObject({ path, code: 'INVALID_JSON' })
    await expect(store.close()).resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('{invalid')
  })
  it('retains the filesystem error code without exposing stored contents', async () => {
    const { root, store } = await createStore()
    await mkdir(join(root, 'renderer-local-storage.json'))
    await expect(store.initialize({})).resolves.toEqual({})
    await expect(store.update({ clear: false, changes: {} })).rejects.toThrow(/EISDIR|EACCES|EPERM/)
  })
  it('keeps initial browser state available when its first durable write fails', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    const blocked = `${path}.${process.pid}.tmp`
    await mkdir(blocked)
    const seed = { appearance: 'dark', credential: 'synthetic-kept-session' }

    await expect(store.initialize(seed)).resolves.toEqual(seed)
    await expect(store.read()).resolves.toEqual(seed)
    await expect(store.update({ clear: false, changes: { appearance: 'light' } })).rejects.toThrow()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(blocked, { recursive: true })
    await store.update({ clear: false, changes: { appearance: 'light' } })
    expect(await store.read()).toEqual({ ...seed, appearance: 'light' })
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toEqual({
      ...seed,
      appearance: 'light',
    })
  })
  it.each(['{broken-json', '{"version":9,"entries":{"credential":"keep"}}'])(
    'keeps the renderer available without replacing damaged durable state: %s',
    async damaged => {
      const { root, store } = await createStore()
      const path = join(root, 'renderer-local-storage.json')
      await writeFile(path, damaged)
      await expect(store.initialize({ appearance: 'light' })).resolves.toEqual({
        appearance: 'light',
      })
      await expect(store.read()).resolves.toEqual({})
      await expect(
        store.update({ clear: false, changes: { appearance: 'dark' } })
      ).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(damaged)
      await writeFile(path, '{"version":1,"entries":{"credential":"repaired"}}')
      await expect(store.read()).resolves.toEqual({ credential: 'repaired' })
      await store.update({ clear: false, changes: { appearance: 'dark' } })
      expect(await store.read()).toEqual({ credential: 'repaired', appearance: 'dark' })
    }
  )
  it('notifies login observers after persistence without allowing them to fail storage updates', async () => {
    const { root } = await createStore()
    const onUpdate = vi.fn(() => {
      throw new Error('observer unavailable')
    })
    const store = new RendererStorageStore(root, onUpdate)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        store.initialize({ 'wework.cloudConnection': 'synthetic-session' })
      ).resolves.toEqual({ 'wework.cloudConnection': 'synthetic-session' })
      await expect(
        store.update({ clear: false, changes: { 'wework.cloudConnection': 'updated-session' } })
      ).resolves.toBeUndefined()
      expect(onUpdate).toHaveBeenCalledTimes(2)
      expect(await store.read()).toEqual({ 'wework.cloudConnection': 'updated-session' })
    } finally {
      warn.mockRestore()
    }
  })

  it('drains accepted writes and closes the renderer persistence boundary before snapshots', async () => {
    const { root, store } = await createStore()
    const first = store.update({ clear: false, changes: { marker: 'before' } })
    const second = store.update({ clear: false, changes: { theme: 'dark' } })
    await store.close()
    await Promise.all([first, second])
    await expect(store.update({ clear: true, changes: {} })).rejects.toThrow('closed')
    await expect(store.clear()).rejects.toThrow('closed')
    expect(
      JSON.parse(await readFile(join(root, 'renderer-local-storage.json'), 'utf8')).entries
    ).toEqual({ marker: 'before', theme: 'dark' })
  })

  it('preserves browser storage until a durable snapshot exists', async () => {
    const { store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).not.toHaveBeenCalled()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
  })

  it('clears legacy browser storage once and later clears only the previous origin', async () => {
    const { root, store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }
    await store.initialize({ appearance: 'dark' })

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).toHaveBeenCalledOnce()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4101"]}\n'
    )

    cleanup.clearAll.mockClear()
    await store.prepareOrigin('http://127.0.0.1:4102', cleanup)

    expect(cleanup.clearAll).not.toHaveBeenCalled()
    expect(cleanup.clearOrigin).toHaveBeenCalledWith('http://127.0.0.1:4101')
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4102"]}\n'
    )

    cleanup.clearOrigin.mockClear()
    await store.prepareOrigin('http://127.0.0.1:4102', cleanup)
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
  })

  it('treats an empty origin list as legacy browser storage', async () => {
    const { root, store } = await createStore()
    const cleanup = {
      clearAll: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
    }
    await store.initialize({ appearance: 'dark' })
    await writeFile(
      join(root, 'renderer-local-storage-origins.json'),
      '{"version":1,"origins":[]}\n'
    )

    await store.prepareOrigin('http://127.0.0.1:4101', cleanup)

    expect(cleanup.clearAll).toHaveBeenCalledOnce()
    expect(cleanup.clearOrigin).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'renderer-local-storage-origins.json'), 'utf8')).toBe(
      '{"version":1,"origins":["http://127.0.0.1:4101"]}\n'
    )
  })

  it('reports a critical file and preserves its bytes until an explicit reset', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage-origins.json')
    await writeFile(path, '{"version":1,"origins":"invalid"}')
    await expect(store.validate()).rejects.toMatchObject({ path, code: 'INVALID_DATA' })
    await expect(readFile(path, 'utf8')).resolves.toContain('"origins":"invalid"')
    await store.clear()
    await expect(store.validate()).resolves.toBeUndefined()
  })

  it.each([
    ['truncated data', Buffer.from([0x7b, 0x22, 0x61, 0xff])],
    ['invalid entries', Buffer.from('{"version":1,"entries":{"appearance":false}}')],
  ])(
    'preserves the exact bytes of %s and repairs only the renderer state',
    async (_label, bytes) => {
      const { root, store } = await createStore()
      const path = join(root, 'renderer-local-storage.json')
      const originPath = join(root, 'renderer-local-storage-origins.json')
      const origins = '{"version":1,"origins":["http://127.0.0.1:4101"]}\n'
      await writeFile(path, bytes)
      await writeFile(originPath, origins)
      const error = await store.validate().catch(cause => cause)
      expect(store.canRepairStartup(error)).toBe(true)
      expect(await readFile(path)).toEqual(bytes)

      const backup = await store.repairStartupState()

      expect(backup?.startsWith(`${path}.corrupt-`)).toBe(true)
      expect(await readFile(backup!)).toEqual(bytes)
      await expect(store.validate()).resolves.toBeUndefined()
      await expect(store.initialize({ stale: 'browser data' })).resolves.toEqual({})
      await expect(readFile(originPath, 'utf8')).resolves.toBe(origins)
      await store.update({ clear: false, changes: { 'new-setting': 'preserve' } })
      await expect(store.repairStartupState()).resolves.toBeNull()
      await expect(store.read()).resolves.toEqual({ 'new-setting': 'preserve' })
      expect((await readdir(root)).filter(name => name.includes('.corrupt-'))).toHaveLength(1)
    }
  )

  it('preserves files from an unsupported schema version during recovery', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    const future = '{"version":2,"entries":{"appearance":"dark"}}'
    await writeFile(path, future)
    const error = await store.validate().catch(cause => cause)
    expect(error).toMatchObject({ path, code: 'UNSUPPORTED_VERSION' })
    expect(store.canRepairStartup(error)).toBe(false)
    await expect(store.repairStartupState()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
    expect(await readdir(root)).toEqual(['renderer-local-storage.json'])
    expect(await readFile(path, 'utf8')).toBe(future)
  })

  it('leaves filesystem read errors for manual recovery', async () => {
    const { root, store } = await createStore()
    const path = join(root, 'renderer-local-storage.json')
    await mkdir(path)
    const error = await store.validate().catch(cause => cause)
    expect(error).toMatchObject({ path })
    expect(store.canRepairStartup(error)).toBe(false)
    await expect(store.repairStartupState()).rejects.toMatchObject({ code: 'NOT_REGULAR_FILE' })
    expect(await readdir(root)).toEqual(['renderer-local-storage.json'])
  })

  it('seeds the durable store once and restores it on later origins', async () => {
    const { root, store } = await createStore()

    await expect(store.initialize({ appearance: 'dark', proxy: 'first' })).resolves.toEqual({
      appearance: 'dark',
      proxy: 'first',
    })
    await expect(
      new RendererStorageStore(root).initialize({ appearance: 'light', stale: 'value' })
    ).resolves.toEqual({
      appearance: 'dark',
      proxy: 'first',
    })
  })

  it('serializes updates, removals, and clears', async () => {
    const { root, store } = await createStore()
    await store.initialize({ first: 'one', removed: 'old' })

    await Promise.all([
      store.update({ clear: false, changes: { first: 'updated', second: 'two' } }),
      store.update({ clear: false, changes: { removed: null } }),
      store.update({ clear: true, changes: { final: 'value' } }),
    ])

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual({
      final: 'value',
    })
    expect(await readFile(join(root, 'renderer-local-storage.json'), 'utf8')).toBe(
      '{"version":1,"entries":{"final":"value"}}\n'
    )
  })

  it('persists prototype-shaped keys as ordinary entries', async () => {
    const { root, store } = await createStore()
    const changes = JSON.parse('{"__proto__":"safe","constructor":"value"}') as Record<
      string,
      string
    >

    await store.update({ clear: true, changes })

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual(changes)
    expect(await readFile(join(root, 'renderer-local-storage.json'), 'utf8')).toBe(
      '{"version":1,"entries":{"__proto__":"safe","constructor":"value"}}\n'
    )
  })

  it('clears all renderer application state', async () => {
    const { root, store } = await createStore()
    await store.initialize({ auth_token: 'token', appearance: 'dark' })

    await store.clear()

    await expect(new RendererStorageStore(root).initialize({})).resolves.toEqual({})
  })
})

it('reads without creating a snapshot or replacing the later renderer seed', async () => {
  const { root, store } = await createStore()
  expect(await store.read()).toEqual({})
  await expect(readFile(join(root, 'renderer-local-storage.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await store.initialize({ appearance: 'dark' })
  expect(await store.read()).toEqual({ appearance: 'dark' })
})
