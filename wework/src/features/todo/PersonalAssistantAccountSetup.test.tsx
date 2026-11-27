import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import {
  assistantDefinitionInputs,
  type PersonalAssistantAccount,
} from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createAssistantSourcesModel } from '@/features/collaboration-exp/assistant/assistantSourcesModel'
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import {
  collectPersonalAssistantDefinitionBackups,
  personalAssistantDeviceSettings,
} from './personalAssistantDeviceSettings'

const account: PersonalAssistantAccount = {
  defaultTeamRef: { name: 'primary', namespace: 'personal-assistant' },
  revision: 'current',
  retiredRoleIds: [],
  definitions: [],
}
const makeTeam = (displayName?: string) => ({
  metadata: { ...account.defaultTeamRef, displayName },
  spec: {
    collaborationModel: 'solo' as const,
    members: [{ botRef: account.defaultTeamRef, role: 'leader' }] as [
      { botRef: typeof account.defaultTeamRef; role: 'leader' },
    ],
  },
})
const blank: PersonalStandInSettings = {
  userId: 7,
  executionDeviceId: 'mac',
  version: 0,
  roles: [],
}

function setup(
  initial: PersonalAssistantAccount | Error | null,
  local = blank,
  boundDevice?: string
) {
  const get = vi.fn(async () => {
    if (initial instanceof Error) throw initial
    return initial
  })
  const personalGet = vi.fn(async (_user: number, device: string) =>
    boundDevice && device !== boundDevice ? blank : local
  )
  const binding = vi.fn(async () => ({
    target: boundDevice ? { userId: 7, deviceId: boundDevice, backendUrl: 'https://cloud' } : null,
  }))
  const initialize = vi.fn<
    NonNullable<WorkbenchServices['personalAssistantAccountApi']>['initialize']
  >(async () => account)
  const services = {
    personalAssistantAccountApi: { get, initialize },
    standInApi: { personalGet, binding },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
  } as unknown as WorkbenchServices
  const workspace = (preferredDevice?: string) => (
    <PersonalAssistantAccountSetup
      services={services}
      userId={7}
      active
      preferredDevice={preferredDevice}
    >
      {assistant => <p>{assistant?.defaultTeamRef.name ?? 'local workspace'}</p>}
    </PersonalAssistantAccountSetup>
  )
  const { rerender } = render(workspace())
  return {
    get,
    personalGet,
    binding,
    initialize,
    changePreferredDevice: (device: string) => rerender(workspace(device)),
  }
}

test('an initialized cloud account opens without probing a legacy profile', async () => {
  const { personalGet, initialize } = setup(account)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(personalGet).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
})

test('the assistant source opens on its cloud device while legacy binding reads are stalled', async () => {
  const binding = vi.fn(() => new Promise<never>(() => {}))
  const personalGet = vi.fn(async () => ({ ...blank, executionDeviceId: 'cloud' }))
  const get = vi.fn(async () => ({
    ...account,
    definitions: [
      {
        roleId: '@primary',
        team: makeTeam('Default'),
        bot: {
          metadata: account.defaultTeamRef,
          spec: { execution_policy: { mode: 'fixed', environment_id: 'cloud' } },
        },
        ghost: { spec: { systemPrompt: '' } },
      },
    ],
  }))
  const services = {
    personalAssistantAccountApi: { get },
    standInApi: { binding, personalGet },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
  } as unknown as WorkbenchServices
  const model = createAssistantSourcesModel(services, services.standInApi, 7, 'account')
  const unsubscribe = model.subscribe(() => {}, false)
  try {
    await waitFor(() => expect(model.getSnapshot().source?.deviceId).toBe('cloud'))
    expect(personalGet).toHaveBeenCalledWith(7, 'cloud')
    expect(binding).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
  }
})

test('device inventory changes keep the loaded cloud assistant mounted', async () => {
  const { get, changePreferredDevice } = setup(account)
  const workspace = await screen.findByText('primary')
  changePreferredDevice('other-cloud-device')
  expect(screen.getByText('primary')).toBe(workspace)
  expect(get).toHaveBeenCalledTimes(1)
})

test('a saved legacy profile requires confirmation before import', async () => {
  const legacy = {
    ...blank,
    version: 1,
    primary: { enabled: true, prompt: 'Handle support requests', preferences: '' },
  }
  const { initialize, personalGet } = setup(null, legacy)
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('personal-assistant-account-migrate-cancel'))
  expect(screen.queryByText('local workspace')).toBeNull()
  const edited = {
    ...legacy,
    version: 2,
    primary: { ...legacy.primary, prompt: 'Updated locally' },
  }
  personalGet.mockResolvedValue(edited)
  fireEvent.click(screen.getByTestId('personal-assistant-account-initialize'))
  expect(confirm).not.toBeInTheDocument()
  fireEvent.click(await screen.findByTestId('personal-assistant-account-migrate-confirm'))
  expect(await screen.findByText('primary')).toBeVisible()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), edited)
})

test('imports a local profile before probing an old remote binding and keeps local execution', async () => {
  const legacy = {
    ...blank,
    userId: 0,
    version: 1,
    primary: { enabled: true, prompt: 'Handle support requests', preferences: '' },
  }
  const { personalGet, binding, initialize } = setup(null, blank, 'docker')
  personalGet.mockImplementation(async user => (user === 0 ? legacy : blank))
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(initialize).not.toHaveBeenCalled()

  fireEvent.click(confirm)
  expect(await screen.findByText('primary')).toBeVisible()
  const [name, settings, device] = initialize.mock.calls[0]
  expect(assistantDefinitionInputs(name, settings, device)[0]).toMatchObject({
    prompt: legacy.primary.prompt,
    executionDeviceId: 'mac',
  })
  expect(binding).not.toHaveBeenCalled()
})

test('imports the bound remote profile after confirmation on the current computer', async () => {
  const remote = { ...blank, version: 1, executionDeviceId: 'docker' }
  const { personalGet, initialize } = setup(null, remote, 'docker')
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(personalGet.mock.calls).toEqual([
    [7, 'mac'],
    [0, 'mac'],
    [7, 'docker'],
    [7, 'docker'],
  ])
  expect(initialize).toHaveBeenCalledWith(expect.any(String), remote)
})

test('an unreachable legacy executor requires a choice before initializing on another device', async () => {
  const { binding, initialize, personalGet } = setup(null, blank, 'docker')
  personalGet.mockImplementation(async (_user, device) => {
    if (device === 'docker') throw Object.assign(new Error('Offline'), { code: 'device_offline' })
    return blank
  })
  const recover = await screen.findByTestId('personal-assistant-recover-unreachable-device')
  expect(initialize).not.toHaveBeenCalled()

  fireEvent.click(recover)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), undefined, 'mac')
  expect(binding.mock.calls).toHaveLength(1)
})

test('a missing cloud and legacy profile takes ordinary initialization', async () => {
  const { initialize } = setup(null)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(screen.queryByTestId('personal-assistant-account-migrate-confirm')).toBeNull()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), undefined, 'mac')
})

test('a failed cloud read cannot trigger initialization or local import', async () => {
  const { personalGet, initialize } = setup(new ApiError('Not Found', 404))
  expect(await screen.findByTestId('personal-assistant-account-retry')).toBeVisible()
  expect(screen.getByTestId('personal-assistant-account-setup')).toHaveTextContent('HTTP 404')
  expect(personalGet).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
})

test('keeps a conflicting device definition in the local backup and projects the cloud definition', async () => {
  const original = {
    ...newStandInRole('old-dev', 'default'),
    name: 'Local name',
    prompt: 'Local prompt',
  }
  const current = {
    ...account,
    definitions: [
      {
        roleId: original.id,
        team: makeTeam('Cloud name'),
        bot: {
          metadata: { ...account.defaultTeamRef, displayName: 'Cloud name' },
          spec: { execution_policy: { mode: 'fixed', environment_id: 'old-dev' } },
        },
        ghost: { spec: { systemPrompt: 'Cloud prompt' } },
      },
    ],
  }
  const services = {
    personalAssistantAccountApi: {},
    standInApi: { personalGet: async () => ({ ...blank, version: 7, roles: [original] }) },
  } as unknown as WorkbenchServices
  const backendUrl = 'https://definition-backup.example/api'
  const api = personalAssistantDeviceSettings(
    services,
    () => current,
    vi.fn(),
    backendUrl,
    id => id === 'mac',
    'mac'
  ).standInApi!
  for (let attempt = 0; attempt < 2; attempt++) {
    const projected = await api.personalGet(7, 'mac', { roleDirectory: true })
    expect(projected.roles[0]).toMatchObject({
      name: 'Cloud name',
      prompt: 'Cloud prompt',
      executionDeviceId: 'mac',
    })
  }
  expect(collectPersonalAssistantDefinitionBackups(backendUrl, 7)).toEqual([
    {
      sourceDeviceId: 'mac',
      profileVersion: 7,
      cloudRevision: current.revision,
      definitions: [
        {
          roleId: original.id,
          name: original.name,
          prompt: original.prompt,
          executionDeviceId: 'old-dev',
        },
      ],
    },
  ])
  expect(collectPersonalAssistantDefinitionBackups(backendUrl, 8)).toEqual([])
})

test('saving and retrying a new shared role never uploads a device-only profile', async () => {
  const local = { ...newStandInRole('mac', 'local'), name: 'Private device role' }
  const newRole = { ...newStandInRole('mac', 'new'), name: 'New shared role', prompt: 'Review' }
  let device = { ...blank, roles: [local] }
  const updateDefinitions = vi.fn().mockRejectedValueOnce(new Error('Offline'))
  const current = {
    ...account,
    definitions: [
      {
        roleId: '@primary',
        team: makeTeam('Default'),
        bot: { metadata: { ...account.defaultTeamRef, displayName: 'Default' } },
        ghost: { spec: { systemPrompt: 'Default prompt' } },
      },
    ],
  }
  updateDefinitions.mockResolvedValueOnce({
    ...current,
    revision: 'updated',
    definitions: [
      ...current.definitions,
      {
        roleId: newRole.id,
        team: makeTeam(newRole.name),
        bot: { metadata: { ...account.defaultTeamRef, displayName: newRole.name } },
        ghost: { spec: { systemPrompt: newRole.prompt } },
      },
    ],
  })
  const services = {
    personalAssistantAccountApi: { updateDefinitions, get: async () => current },
    standInApi: {
      personalGet: async () => device,
      async personalSave(_user: number, settings: PersonalStandInSettings) {
        device = { ...settings, version: device.version + 1 }
        return device
      },
    },
  } as unknown as WorkbenchServices
  const api = personalAssistantDeviceSettings(services, () => current, vi.fn()).standInApi!
  const settings = await api.personalGet(7, 'mac')
  await api.personalSave(7, settings, 'mac')
  expect(updateDefinitions).not.toHaveBeenCalled()
  expect(device.primary).toBeUndefined()

  const draft = { ...settings, version: device.version, roles: [...settings.roles, newRole] }
  const change = { kind: 'create', roleId: newRole.id } as const
  await expect(api.personalSave(7, draft, 'mac', undefined, change)).rejects.toMatchObject({
    code: 'cloud_definition_save_unconfirmed',
  })
  expect(device.roles.map(role => role.id)).toEqual([local.id, newRole.id])
  expect(device.primary).toBeUndefined()
  await api.personalSave(7, { ...draft, version: device.version }, 'mac', undefined, change)
  expect(updateDefinitions).toHaveBeenLastCalledWith(current.revision, [
    { roleId: '@primary', name: 'Default', prompt: 'Default prompt' },
    {
      roleId: newRole.id,
      name: newRole.name,
      prompt: newRole.prompt,
      executionDeviceId: newRole.executionDeviceId,
    },
  ])
})
