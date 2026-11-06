import { expect, test, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInMemory } from '@/api/standIn'
import { migrateStandIn } from './migrateStandIn'

function fixture() {
  const source: PersonalStandInSettings = {
    userId: 0,
    executionDeviceId: 'mac',
    version: 3,
    primary: { enabled: false, prompt: 'Shared instructions', preferences: 'Prefer Chinese' },
    roles: [
      {
        ...newStandInRole('mac', 'review'),
        name: 'Reviewer',
        prompt: 'Review risks',
        enabled: true,
        workspace: { projectKey: 'private-local-path' },
        connections: [
          {
            providerId: 'mail',
            id: 'private',
            profile: 'local',
            name: 'Private mail',
            kind: 'inbox',
            policy: { automatic: true, askBeforeAct: true },
          },
        ],
      },
    ],
  }
  let target: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'cloud',
    version: 4,
    roles: [{ ...newStandInRole('cloud', 'existing'), name: 'Existing cloud role' }],
  }
  const sourceMemories: StandInMemory[] = [
    {
      id: 'personal',
      content: 'Shared memory',
      scope: { kind: 'personal' },
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'review',
      content: 'Review memory',
      scope: { kind: 'role', roleId: 'review' },
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'other',
      content: 'Other role private memory',
      scope: { kind: 'role', roleId: 'other' },
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
  ]
  const imported: StandInMemory[] = []
  const personalGet = vi.fn(async (_user: number, device: string) =>
    structuredClone(device === 'mac' ? source : target)
  )
  const personalSave = vi.fn(
    async (_user: number, value: PersonalStandInSettings, device: string) => {
      if (device === 'cloud') target = structuredClone(value)
      return value
    }
  )
  const memories = vi.fn(async (_user: number, device: string) =>
    structuredClone(device === 'mac' ? sourceMemories : imported)
  )
  const saveMemory = vi.fn(
    async (_user: number, _device: string, value: Partial<StandInMemory>) => {
      const row = { ...value, id: `imported-${imported.length}`, version: 1 } as StandInMemory
      imported.push(row)
      return row
    }
  )
  const api = { personalGet, personalSave, memories, saveMemory } as unknown as StandInExecutorApi
  const input = {
    sourceUser: 0,
    sourceDevice: 'mac',
    roleId: 'review',
    targetUser: 7,
    targetDevice: 'cloud',
    primaryName: 'My stand-in',
  }
  return {
    api,
    input,
    source,
    personalGet,
    personalSave,
    memories,
    saveMemory,
    imported,
    target: () => target,
  }
}

test('merges portable settings and role-visible memories without moving history or device permissions', async () => {
  const f = fixture()
  const role = await migrateStandIn(f.api, f.input)
  expect(role.id.length).toBeLessThanOrEqual(64)
  expect(role).toMatchObject({
    name: 'Reviewer',
    enabled: false,
    executionDeviceId: 'cloud',
    prompt: 'Shared instructions\n\nPrefer Chinese\n\nReview risks',
  })
  expect(role.workspace).toBeUndefined()
  expect(role.connections).toBeUndefined()
  expect(role.collaboration.enabled).toBe(false)
  expect(f.target().roles.map(row => row.name)).toEqual(['Existing cloud role', 'Reviewer'])
  expect(f.imported.map(row => row.content)).toEqual(['Shared memory', 'Review memory'])
  expect(f.imported.every(row => row.scope.kind === 'role' && row.scope.roleId === role.id)).toBe(
    true
  )
  expect(f.personalSave.mock.calls.at(-1)?.[2]).toBe('mac')
  expect(f.personalSave.mock.calls.at(-1)?.[1].roles[0].enabled).toBe(false)
  expect(f.source.roles[0].enabled).toBe(true)
})

test('a failed cloud memory write leaves local intake unchanged and retry reuses the prepared role', async () => {
  const f = fixture()
  f.saveMemory.mockRejectedValueOnce(new Error('cloud offline'))
  await expect(migrateStandIn(f.api, f.input)).rejects.toThrow('cloud offline')
  expect(f.personalSave.mock.calls.every(call => call[2] === 'cloud')).toBe(true)
  await migrateStandIn(f.api, f.input)
  expect(f.target().roles).toHaveLength(2)
  expect(f.imported).toHaveLength(2)
})

test('retry deduplicates already copied memories and never overwrites existing cloud configuration', async () => {
  const f = fixture()
  await migrateStandIn(f.api, f.input)
  await migrateStandIn(f.api, f.input)
  expect(f.imported).toHaveLength(2)
  expect(f.target().roles).toHaveLength(2)
  f.target().roles[1].prompt = 'Changed on cloud'
  const calls = f.personalSave.mock.calls.length
  await expect(migrateStandIn(f.api, f.input)).rejects.toMatchObject({ code: 'conflict' })
  expect(f.personalSave).toHaveBeenCalledTimes(calls)
})

test('a concurrent source edit prevents pausing local intake after copying', async () => {
  const f = fixture()
  const original = f.personalGet.getMockImplementation()!
  let reads = 0
  f.personalGet.mockImplementation(async (user, device) => {
    const result = await original(user, device)
    if (device === 'mac' && ++reads > 1) result.version++
    return result
  })
  await expect(migrateStandIn(f.api, f.input)).rejects.toMatchObject({ code: 'changed' })
  expect(f.personalSave.mock.calls.every(call => call[2] === 'cloud')).toBe(true)
})

test('migrates the primary profile as a separate role without replacing the cloud primary', async () => {
  const f = fixture()
  const role = await migrateStandIn(f.api, { ...f.input, roleId: undefined })
  expect(role.name).toBe('My stand-in')
  expect(f.imported.map(row => row.content)).toEqual(['Shared memory'])
  expect(f.personalSave.mock.calls.at(-1)?.[1].primary?.enabled).toBe(false)
  expect(f.personalSave.mock.calls.at(-1)?.[1].roles[0].enabled).toBe(true)
})

test('rejects same-device transfers before reading or writing any data', async () => {
  const f = fixture()
  await expect(migrateStandIn(f.api, { ...f.input, targetDevice: 'mac' })).rejects.toMatchObject({
    code: 'same_device',
  })
  expect(f.personalGet).not.toHaveBeenCalled()
})
