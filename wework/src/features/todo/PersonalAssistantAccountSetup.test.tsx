import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import { personalAssistantDeviceSettings } from './personalAssistantDeviceSettings'
import { usePersonalStandIn } from './usePersonalStandIn'

const account: PersonalAssistantAccount = {
  defaultBotRef: { name: 'primary', namespace: 'personal-assistant' },
  revision: 'current',
  retiredRoleIds: [],
  definitions: [],
}
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
  const initialize = vi.fn(async () => account)
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
      {assistant => <p>{assistant?.defaultBotRef.name ?? 'local workspace'}</p>}
    </PersonalAssistantAccountSetup>
  )
  const { rerender } = render(workspace())
  return {
    get,
    personalGet,
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

test('imports the bound remote profile after confirmation on the current computer', async () => {
  const remote = { ...blank, version: 1, executionDeviceId: 'docker' }
  const { personalGet, initialize } = setup(null, remote, 'docker')
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(personalGet.mock.calls).toEqual([
    [7, 'docker'],
    [7, 'docker'],
  ])
  expect(initialize).toHaveBeenCalledWith(expect.any(String), remote)
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
        bot: { metadata: { ...account.defaultBotRef, displayName: 'Default' } },
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
        bot: { metadata: { ...account.defaultBotRef, displayName: newRole.name } },
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

test.each([false, true])(
  'retains a conflicting draft until the peer revision is explicitly reloaded (refresh fails: %s)',
  async refreshFails => {
    const role = { ...newStandInRole('mac', 'shared'), name: 'Shared role', prompt: 'Handle PRs' }
    let device = { ...blank, roles: [role] }
    const originalAccount: PersonalAssistantAccount = {
      ...account,
      revision: 'rev-1',
      definitions: [
        {
          roleId: '@primary',
          bot: { metadata: { ...account.defaultBotRef, displayName: 'Default' } },
          ghost: { spec: { systemPrompt: 'Default instructions' } },
        },
        {
          roleId: role.id,
          bot: {
            metadata: { ...account.defaultBotRef, displayName: role.name },
            spec: { execution_policy: { mode: 'fixed' as const, environment_id: 'mac' } },
          },
          ghost: { spec: { systemPrompt: role.prompt } },
        },
      ],
    }
    const peerUpdatedAccount: PersonalAssistantAccount = {
      ...originalAccount,
      revision: 'rev-2',
      definitions: [
        originalAccount.definitions[0],
        {
          roleId: role.id,
          bot: {
            metadata: { ...account.defaultBotRef, displayName: role.name },
            spec: { execution_policy: { mode: 'fixed' as const, environment_id: 'cloud-1' } },
          },
          ghost: { spec: { systemPrompt: 'Review peer changes' } },
        },
      ],
    }
    const accepted: PersonalAssistantAccount = {
      ...peerUpdatedAccount,
      revision: 'rev-3',
      definitions: peerUpdatedAccount.definitions.map(definition =>
        definition.roleId === role.id
          ? {
              ...definition,
              bot: {
                ...definition.bot,
                metadata: { ...definition.bot.metadata, displayName: 'My edited name' },
              },
            }
          : definition
      ),
    }
    let latestAccount = originalAccount
    const get = vi.fn(async () => peerUpdatedAccount)
    if (refreshFails) get.mockRejectedValueOnce(new Error('Offline'))
    const updateDefinitions = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Conflict', 409))
      .mockResolvedValueOnce(accepted)
    const personalSave = vi.fn(async (_user: number, settings: PersonalStandInSettings) => {
      device = { ...settings, version: device.version + 1 }
      return device
    })
    const services = {
      personalAssistantAccountApi: { updateDefinitions, get },
      standInApi: {
        personalGet: async () => device,
        personalSave,
      },
    } as unknown as WorkbenchServices
    const projectedServices = personalAssistantDeviceSettings(
      services,
      () => latestAccount,
      next => {
        latestAccount = next
      }
    )
    const { result } = renderHook(() => usePersonalStandIn(projectedServices, 7, 'mac', 'mac'))
    await waitFor(() => expect(result.current.saved?.cloudDefinitionRevision).toBe('rev-1'))
    const editName = () =>
      act(() => result.current.updateRole(role.id, value => ({ ...value, name: 'My edited name' })))
    const change = { kind: 'update', roleId: role.id } as const
    editName()
    await act(async () => expect(await result.current.save(undefined, change)).toBeNull())
    expect(result.current.draft?.cloudDefinitionRevision).toBe('rev-1')
    expect(result.current.draft?.roles[0]).toMatchObject({
      name: 'My edited name',
      prompt: role.prompt,
      executionDeviceId: 'mac',
    })
    expect(result.current.error).toBeTruthy()
    await act(async () => expect(await result.current.save(undefined, change)).toBeNull())
    expect(personalSave).toHaveBeenCalledTimes(1)
    expect(updateDefinitions).toHaveBeenCalledTimes(1)

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.draft?.cloudDefinitionRevision).toBe('rev-2'))
    expect(result.current.draft?.roles[0]).toMatchObject({
      name: role.name,
      prompt: 'Review peer changes',
      executionDeviceId: 'cloud-1',
    })
    editName()
    await act(async () =>
      expect(await result.current.save(undefined, change)).toMatchObject({
        cloudDefinitionRevision: 'rev-3',
      })
    )
    expect(updateDefinitions).toHaveBeenLastCalledWith('rev-2', [
      { roleId: '@primary', name: 'Default', prompt: 'Default instructions' },
      {
        roleId: role.id,
        name: 'My edited name',
        prompt: 'Review peer changes',
        executionDeviceId: 'cloud-1',
      },
    ])
  }
)
