import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
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
})
