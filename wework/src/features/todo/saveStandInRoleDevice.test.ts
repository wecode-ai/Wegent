import { describe, expect, it, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { saveStandInRoleDevice } from './saveStandInRoleDevice'

function fixture() {
  const role = {
    ...newStandInRole('mac', 'review'),
    enabled: true,
    name: 'Review',
    prompt: 'Old configuration',
  }
  const source: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'mac',
    version: 1,
    roles: [role],
  }
  const profiles = new Map<string, PersonalStandInSettings>([
    ['mac', structuredClone(source)],
    ['remote', { userId: 7, executionDeviceId: 'remote', version: 0, roles: [] }],
  ])
  const personalGet = vi.fn(async (_user: number, device: string) =>
    structuredClone(profiles.get(device)!)
  )
  const personalSave = vi.fn(
    async (_user: number, value: PersonalStandInSettings, device: string) => {
      if (profiles.get(device)!.version !== value.version)
        throw Object.assign(new Error('Conflict'), { code: 'version_conflict' })
      const saved = structuredClone({ ...value, version: value.version + 1 })
      profiles.set(device, saved)
      return saved
    }
  )
  const api = { personalGet, personalSave } as unknown as StandInExecutorApi
  const updated = { ...role, executionDeviceId: 'remote', prompt: 'New configuration' }
  const input = {
    userId: 7,
    sourceDevice: 'mac',
    source,
    draft: { ...source, roles: [updated] },
    role: updated,
  }
  return { api, input, profiles, personalGet, personalSave }
}

describe('role execution device changes', () => {
  it('creates a new role only on its selected device without changing unrelated source roles', async () => {
    const f = fixture()
    const role = { ...f.input.role, id: 'new-role', version: 0 }
    const before = structuredClone(f.profiles.get('mac'))
    const result = await saveStandInRoleDevice(f.api, {
      ...f.input,
      draft: { ...f.input.source, roles: [...f.input.source.roles, role] },
      role,
    })
    expect(result.id).toBe('new-role')
    expect(result.executionDeviceId).toBe('remote')
    expect(result.migrationSource).toBeUndefined()
    expect(f.profiles.get('mac')).toEqual(before)
    expect(f.personalSave).toHaveBeenCalledTimes(1)
    expect(f.personalSave.mock.calls[0][2]).toBe('remote')
    expect(f.profiles.get('remote')!.roles[0]).toEqual(role)
  })

  it('does not confuse two Runtime registrations that share a desktop alias', async () => {
    const f = fixture()
    f.profiles.get('remote')!.executionDeviceId = 'mac'
    f.api.deviceIdentity = vi.fn(async device => ({
      deviceId: 'mac',
      backendDeviceId: device === 'mac' ? 'app-record-1' : 'app-record-2',
    }))
    await saveStandInRoleDevice(f.api, f.input)
    expect(f.personalSave).toHaveBeenCalledTimes(3)
    expect(f.profiles.get('remote')!.roles[0].enabled).toBe(true)
  })

  it('updates one profile without staging a second receiver when two addresses identify it', async () => {
    const f = fixture()
    f.profiles.get('remote')!.executionDeviceId = 'mac'
    f.api.deviceIdentity = vi.fn(async () => ({ deviceId: 'mac', backendDeviceId: 'app-record-1' }))
    await saveStandInRoleDevice(f.api, f.input)
    expect(f.personalSave).toHaveBeenCalledTimes(1)
    expect(f.personalSave.mock.calls[0][2]).toBe('mac')
  })
  it('routes new work to the target while preserving the source role and task configuration', async () => {
    const f = fixture()
    const result = await saveStandInRoleDevice(f.api, f.input)
    expect(result.id).toBe('review')
    expect(result.executionDeviceId).toBe('remote')
    expect(result.previousExecutionDevices).toEqual(['mac'])
    expect(f.profiles.get('mac')!.roles[0]).toMatchObject({
      enabled: true,
      executionDeviceId: 'remote',
      prompt: 'Old configuration',
    })
    expect(f.profiles.get('remote')!.roles[0]).toMatchObject({
      enabled: true,
      prompt: 'New configuration',
    })
    expect(
      f.personalSave.mock.calls.map(([, value, device]) => [device, value.roles[0].enabled])
    ).toEqual([
      ['remote', false],
      ['mac', true],
      ['remote', true],
    ])
    expect(f.profiles.get('mac')!.executionDeviceId).toBe('mac')
  })

  it('rejects a conflicting target role without changing either receiver', async () => {
    const f = fixture()
    f.profiles.get('remote')!.roles = [
      { ...newStandInRole('remote', 'review'), enabled: true, name: 'Other' },
    ]
    await expect(saveStandInRoleDevice(f.api, f.input)).rejects.toMatchObject({
      code: 'stand_in_role_device_conflict',
    })
    expect(f.personalSave).not.toHaveBeenCalled()
  })

  it('restores source intake when the target activation is rejected before commit', async () => {
    const f = fixture()
    const save = f.personalSave.getMockImplementation()!
    f.personalSave.mockImplementation(async (user, value, device) => {
      if (device === 'remote' && value.roles[0].enabled) throw new Error('Activation rejected')
      return save(user, value, device)
    })
    await expect(saveStandInRoleDevice(f.api, f.input)).rejects.toThrow('Activation rejected')
    expect(f.profiles.get('mac')!.roles[0].executionDeviceId).toBe('mac')
    expect(f.profiles.get('remote')!.roles[0].enabled).toBe(false)
  })

  it('never reactivates source intake after a committed activation loses its response', async () => {
    const f = fixture()
    const save = f.personalSave.getMockImplementation()!
    f.personalSave.mockImplementation(async (user, value, device) => {
      const result = await save(user, value, device)
      if (device === 'remote' && value.roles[0].enabled) throw new Error('Response lost')
      return result
    })
    await expect(saveStandInRoleDevice(f.api, f.input)).rejects.toMatchObject({
      code: 'stand_in_role_device_incomplete',
    })
    expect(f.profiles.get('mac')!.roles[0].executionDeviceId).toBe('remote')
    expect(f.profiles.get('remote')!.roles[0].enabled).toBe(true)
    expect(f.personalSave).toHaveBeenCalledTimes(3)
  })

  it('does not stage a target from an outdated source draft', async () => {
    const f = fixture()
    f.profiles.get('mac')!.version++
    await expect(saveStandInRoleDevice(f.api, f.input)).rejects.toMatchObject({
      code: 'version_conflict',
    })
    expect(f.personalSave).not.toHaveBeenCalled()
  })
})
