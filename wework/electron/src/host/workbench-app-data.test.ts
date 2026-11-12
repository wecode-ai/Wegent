import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { WorkbenchAppDataStore } from './workbench-app-data.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-app-data-'))
  roots.push(root)
  return new WorkbenchAppDataStore(root)
}

describe('DSH installation data', () => {
  test('preserves ordinary state from files with obsolete reminder metadata', async () => {
    const store = await fixture()
    const state = [{ id: 'one', text: 'Keep this task', done: true, at: 'obsolete' }]
    await mkdir(join(store.path('notes'), '..'), { recursive: true })
    await writeFile(store.path('notes'), JSON.stringify({ state, reminders: { obsolete: true } }))
    expect(await store.read('notes')).toEqual({ state })
    await store.commit('notes', [...state, { id: 'two', text: 'New task', done: false }])
    expect(JSON.parse(await readFile(store.path('notes'), 'utf8'))).toEqual({
      state: [...state, { id: 'two', text: 'New task', done: false }],
    })
  })

  test('legacy conflict preflight leaves existing data intact and does not create an empty target', async () => {
    const store = await fixture()
    const legacy = { state: { legacy: true } }
    await store.checkLegacyImport('new', legacy)
    await expect(readFile(store.path('new'))).rejects.toMatchObject({ code: 'ENOENT' })
    await store.commit('notes', { current: true })
    await expect(store.checkLegacyImport('notes', legacy)).rejects.toThrow('already exists')
    expect((await store.read('notes')).state).toEqual({ current: true })
    await store.checkLegacyImport('notes', { state: { current: true } })
  })
  test('serializes concurrent writes and snapshots caller input before queuing', async () => {
    const store = await fixture()
    const state = { tasks: ['original'] }
    const save = store.commit('market-42', state)
    state.tasks[0] = 'mutated'
    await Promise.all([
      save,
      store.update('market-42', data => {
        const state = data.state as { tasks: string[] }
        state.tasks.push('queued')
      }),
    ])
    expect(await store.read('market-42')).toEqual({
      state: { tasks: ['original', 'queued'] },
    })
    expect(JSON.parse(await readFile(store.path('market-42'), 'utf8'))).toEqual(
      await store.read('market-42')
    )
  })

  test('recovers the serialization queue after a failed mutation and removes only the owner data', async () => {
    const store = await fixture()
    await store.commit('one', { private: 1 })
    await store.commit('two', { private: 2 })
    await expect(
      store.update('one', () => {
        throw new Error('mutation failed')
      })
    ).rejects.toThrow('mutation failed')
    await store.commit('one', { private: 3 })
    await store.remove('one')
    expect(await store.read('one')).toEqual({ state: null })
    expect((await store.read('two')).state).toEqual({ private: 2 })
  })

  test.each(['../other', '.', '..', 'folder/file', 'folder\\file', '', '-first', 'a'.repeat(129)])(
    'rejects unsafe installation identity %s',
    async id => {
      const store = await fixture()
      expect(() => store.path(id)).toThrow('Invalid workbench installation id')
    }
  )
})
