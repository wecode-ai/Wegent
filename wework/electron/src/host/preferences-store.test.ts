import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PreferencesStore } from './preferences-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('PreferencesStore', () => {
  test('distinguishes unavailable preferences from fresh defaults and explicit opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-availability-'))
    roots.push(root)
    const store = new PreferencesStore(root)
    const path = join(root, 'app-preferences.json')
    await expect(store.readSnapshot()).resolves.toEqual({ preferences: {}, readable: true })
    await mkdir(path)
    await expect(store.readSnapshot()).resolves.toEqual({ preferences: {}, readable: false })
    await expect(store.update({ localCodexSubscriptionEnabled: true })).rejects.toThrow()
    await rm(path, { recursive: true })
    await store.update({ localCodexSubscriptionEnabled: false })
    await expect(store.readSnapshot()).resolves.toEqual({
      preferences: { localCodexSubscriptionEnabled: false },
      readable: true,
    })
  })
  test('drains accepted writes and rejects later writers before an upgrade snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-close-'))
    roots.push(root)
    const store = new PreferencesStore(root)
    const first = store.update({ locale: 'zh-CN' })
    const second = store.update({ theme: 'dark' })
    await store.close()
    await Promise.all([first, second])
    await expect(store.update({ theme: 'light' })).rejects.toThrow('closed')
    await expect(store.clear()).rejects.toThrow('closed')
    expect(JSON.parse(await readFile(join(root, 'app-preferences.json'), 'utf8'))).toEqual({
      locale: 'zh-CN',
      theme: 'dark',
    })
  })

  test('persists merged updates atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-'))
    roots.push(root)
    const store = new PreferencesStore(root)

    await expect(store.read()).resolves.toEqual({})
    await expect(store.update({ locale: 'zh-CN' })).resolves.toEqual({
      locale: 'zh-CN',
    })
    await expect(store.update({ theme: 'dark' })).resolves.toEqual({
      locale: 'zh-CN',
      theme: 'dark',
    })

    await expect(new PreferencesStore(root).read()).resolves.toEqual({
      locale: 'zh-CN',
      theme: 'dark',
    })
    expect(await readFile(join(root, 'app-preferences.json'), 'utf8')).toContain('"theme": "dark"')
  })

  test('clears persisted application preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-'))
    roots.push(root)
    const store = new PreferencesStore(root)
    await store.update({ locale: 'zh-CN', appearanceMode: 'dark' })

    await store.clear()

    await expect(new PreferencesStore(root).read()).resolves.toEqual({})
  })

  test.each(['{"locale": "zh-CN"', 'null', '[]'])(
    'preserves damaged preferences and treats consent as unknown: %s',
    async damaged => {
      const root = await mkdtemp(join(tmpdir(), 'wework-preferences-'))
      roots.push(root)
      const path = join(root, 'app-preferences.json')
      await writeFile(path, damaged)
      const store = new PreferencesStore(root)
      await expect(store.readSnapshot()).resolves.toEqual({ preferences: {}, readable: false })
      await expect(store.update({ localCodexSubscriptionEnabled: true })).rejects.toThrow('damaged')
      expect(await readFile(path, 'utf8')).toBe(damaged)
      await expect(new PreferencesStore(root).readSnapshot()).resolves.toEqual({
        preferences: {},
        readable: false,
      })
      await writeFile(path, '{"localCodexSubscriptionEnabled":false}')
      await expect(store.readSnapshot()).resolves.toEqual({
        preferences: { localCodexSubscriptionEnabled: false },
        readable: true,
      })
    }
  )

  test('opens with defaults but refuses to overwrite an unreadable file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-'))
    roots.push(root)
    const path = join(root, 'app-preferences.json')
    await mkdir(path)
    const store = new PreferencesStore(root)

    await expect(store.read()).resolves.toEqual({})
    const error = (await store
      .update({ theme: 'dark' })
      .catch(caught => caught)) as NodeJS.ErrnoException

    expect(['EISDIR', 'EPERM', 'EACCES']).toContain(error.code)
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(await readdir(root)).toEqual(['app-preferences.json'])
  })
})
