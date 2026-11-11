import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

const future = () => ({
  id: 'alarm',
  title: 'Due',
  body: '',
  at: new Date(Date.now() + 60_000).toISOString(),
})

describe('DSH installation data', () => {
  test('legacy conflict preflight leaves existing data intact and does not create an empty target', async () => {
    const store = await fixture()
    const legacy = { state: { legacy: true }, reminders: [] }
    await store.checkLegacyImport('new', legacy)
    await expect(readFile(store.path('new'))).rejects.toMatchObject({ code: 'ENOENT' })
    await store.commit('notes', { current: true })
    await expect(store.checkLegacyImport('notes', legacy)).rejects.toThrow('already exists')
    expect((await store.read('notes')).state).toEqual({ current: true })
    await store.checkLegacyImport('notes', { state: { current: true }, reminders: [] })
  })
  test('serializes concurrent writes and snapshots caller input before queuing', async () => {
    const store = await fixture()
    const state = { tasks: ['original'] }
    const reminder = future()
    const save = store.commit('market-42', state)
    state.tasks[0] = 'mutated'
    await Promise.all([
      save,
      store.update('market-42', data => {
        data.reminders.push(reminder)
      }),
    ])
    expect(await store.read('market-42')).toEqual({
      state: { tasks: ['original'] },
      reminders: [reminder],
    })
    expect(JSON.parse(await readFile(store.path('market-42'), 'utf8'))).toEqual(
      await store.read('market-42')
    )
  })

  test('preserves overdue existing reminders but rejects new overdue or duplicate alarms atomically', async () => {
    const store = await fixture()
    const overdue = { ...future(), at: new Date(0).toISOString() }
    await store.importLegacy('linked.app_1', { state: 'imported', reminders: [overdue] })
    await store.commit('linked.app_1', 'edited', [overdue])
    expect(() => store.commit('linked.app_1', 'broken', [overdue, overdue])).toThrow('unique')
    await expect(
      store.commit('linked.app_1', 'broken', [{ ...overdue, id: 'new' }])
    ).rejects.toThrow('future')
    expect(await store.read('linked.app_1')).toEqual({ state: 'edited', reminders: [overdue] })
    await store.commit('linked.app_1', 'valid', [])
    expect(await store.read('linked.app_1')).toEqual({ state: 'valid', reminders: [] })
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
    expect(await store.read('one')).toEqual({ state: null, reminders: [] })
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
