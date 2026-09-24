import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PreferencesStore } from './preferences-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('PreferencesStore', () => {
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

  test('quarantines an unreadable preferences file instead of failing forever', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const root = await mkdtemp(join(tmpdir(), 'wework-preferences-'))
    roots.push(root)
    const path = join(root, 'app-preferences.json')
    const damaged = `{"locale": "zh-CN"\u0000\u0000`
    await writeFile(path, damaged, 'utf8')
    const store = new PreferencesStore(root)

    await expect(store.read()).resolves.toEqual({})

    const quarantined = (await readdir(root)).filter(name =>
      name.startsWith('app-preferences.json.corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    await expect(readFile(join(root, quarantined[0] as string), 'utf8')).resolves.toBe(damaged)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // The next write publishes a valid file again, so the store heals itself.
    await expect(store.update({ locale: 'zh-CN' })).resolves.toEqual({ locale: 'zh-CN' })
    await expect(new PreferencesStore(root).read()).resolves.toEqual({ locale: 'zh-CN' })
    warning.mockRestore()
  })
})
