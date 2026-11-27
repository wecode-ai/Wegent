import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import {
  assistantDefinitionInputs,
  type PersonalAssistantAccount,
} from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import type { CloudWorkCheckStatus } from '@/types/workbench'
import { createAssistantSourcesModel } from '@/features/collaboration-exp/assistant/assistantSourcesModel'
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import {
  collectPersonalAssistantDefinitionBackups,
  personalAssistantDeviceSettings,
} from './personalAssistantDeviceSettings'
import { usePersonalStandIn } from './usePersonalStandIn'
import type { StandInEntry } from './standInEntry'

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
  initial: PersonalAssistantAccount | Error | null | Promise<PersonalAssistantAccount | null>,
  local = blank,
  boundDevice?: string,
  options?: {
    preferredDevice?: string
    initialEntry?: StandInEntry
    devices?: DeviceInfo[]
    deviceCatalogStatus?: CloudWorkCheckStatus
    personalGet?: (userId: number, deviceId: string) => Promise<PersonalStandInSettings>
  }
) {
  const get = vi.fn(async () => {
    if (initial instanceof Error) throw initial
    return initial
  })
  const personalGet = vi.fn(
    options?.personalGet ??
      (async (_user: number, device: string) =>
        boundDevice && device !== boundDevice ? blank : local)
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
  let publishAccount: ((value: PersonalAssistantAccount) => void) | undefined
  let readAccount: (() => PersonalAssistantAccount | undefined) | undefined
  let devices = options?.devices
  let status = options?.deviceCatalogStatus
  let preferredDevice = options?.preferredDevice
  const workspace = () => (
    <PersonalAssistantAccountSetup
      services={services}
      userId={7}
      active
      preferredDevice={preferredDevice}
      initialEntry={options?.initialEntry}
      devices={devices}
      deviceCatalogStatus={status}
    >
      {(assistant, publish, read, reloadAccount) => {
        publishAccount = publish
        readAccount = read
        return (
          <>
            <p>{assistant?.defaultTeamRef.name ?? 'local workspace'}</p>
            <button type="button" data-testid="test-account-reload" onClick={reloadAccount}>
              Refresh account
            </button>
          </>
        )
      }}
    </PersonalAssistantAccountSetup>
  )
  const { rerender } = render(workspace())
  return {
    get,
    binding,
    personalGet,
    initialize,
    publishAccount: (value: PersonalAssistantAccount) => publishAccount?.(value),
    readAccount: () => readAccount?.(),
    changePreferredDevice: (device: string) => {
      preferredDevice = device
      rerender(workspace())
    },
    changeDeviceCatalog: (nextDevices: DeviceInfo[], nextStatus: CloudWorkCheckStatus) => {
      devices = nextDevices
      status = nextStatus
      rerender(workspace())
    },
  }
}

test('an initialized cloud account opens without probing a legacy profile', async () => {
  const { personalGet, initialize } = setup(account)
  const primary = await screen.findByText('primary')
  expect(primary).toBeVisible()
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
  const unsubscribe = model.subscribe(() => {}, false, [], false)
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

test('a transient account refresh failure leaves the loaded workspace mounted and retryable', async () => {
  const { get } = setup(account)
  const workspace = await screen.findByText('primary')
  get.mockRejectedValueOnce(new ApiError('Offline', 503))
  fireEvent.click(screen.getByTestId('test-account-reload'))
  expect(await screen.findByTestId('personal-assistant-account-refresh-error')).toBeVisible()
  expect(screen.getByText('primary')).toBe(workspace)
  fireEvent.click(screen.getByTestId('personal-assistant-account-retry'))
  await waitFor(() =>
    expect(screen.queryByTestId('personal-assistant-account-refresh-error')).toBeNull()
  )
  expect(screen.getByText('primary')).toBe(workspace)
})

test('a denied account refresh hides the previously loaded workspace', async () => {
  const { get, publishAccount, readAccount } = setup(account)
  expect(await screen.findByText('primary')).toBeVisible()
  get.mockRejectedValueOnce(new ApiError('Forbidden', 403))
  fireEvent.click(screen.getByTestId('test-account-reload'))
  expect(await screen.findByTestId('personal-assistant-account-retry')).toBeVisible()
  expect(screen.queryByText('primary')).toBeNull()
  expect(screen.queryByTestId('personal-assistant-account-refresh-error')).toBeNull()
  // An old save can complete after the account lookup was denied.
  act(() => publishAccount(account))
  expect(readAccount()).toBeUndefined()
  expect(screen.queryByText('primary')).toBeNull()
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

test('a registered peer binding is preserved even when that device is offline', async () => {
  const remote = { ...blank, version: 1, executionDeviceId: 'electron-peer' }
  const { personalGet, initialize } = setup(null, remote, remote.executionDeviceId, {
    devices: [
      {
        id: 2,
        device_id: remote.executionDeviceId,
        name: 'Peer desktop',
        device_type: 'remote',
        bind_shell: 'claudecode',
        status: 'offline',
        is_default: false,
      },
    ],
  })
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(personalGet.mock.calls).toEqual([
    [7, 'mac'],
    [0, 'mac'],
    [7, remote.executionDeviceId],
  ])
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  expect(await screen.findByText('primary')).toBeVisible()
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

test('a legacy binding is not normalized to the local device before the peer catalog resolves', async () => {
  const remote = { ...blank, version: 1, executionDeviceId: 'electron-peer' }
  const { binding, personalGet, initialize, changeDeviceCatalog } = setup(
    null,
    remote,
    remote.executionDeviceId,
    { devices: [], deviceCatalogStatus: 'syncing' }
  )
  await waitFor(() => expect(binding).toHaveBeenCalledTimes(1))
  expect(personalGet.mock.calls).toEqual([
    [7, 'mac'],
    [0, 'mac'],
  ])
  expect(initialize).not.toHaveBeenCalled()
  changeDeviceCatalog([peer], 'available')
  expect(await screen.findByTestId('personal-assistant-account-migrate-confirm')).toBeVisible()
  expect(personalGet.mock.calls).toEqual([
    [7, 'mac'],
    [0, 'mac'],
    [7, 'mac'],
    [0, 'mac'],
    [7, remote.executionDeviceId],
  ])
  expect(initialize).not.toHaveBeenCalled()
})

test('a missing cloud and legacy profile takes ordinary initialization', async () => {
  const { initialize } = setup(null, blank, undefined, { deviceCatalogStatus: 'syncing' })
  const primary = await screen.findByText('primary')
  expect(primary).toBeVisible()
  expect(screen.queryByTestId('personal-assistant-account-migrate-confirm')).toBeNull()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), undefined, 'mac')
})

test('first-use primary identity link initializes on the verified local device', async () => {
  const { initialize } = setup(null, blank, undefined, {
    preferredDevice: 'cloud',
    deviceCatalogStatus: 'syncing',
    initialEntry: {
      kind: 'identity',
      deviceId: 'mac',
      profileId: '@primary',
      userId: '7',
      scheduled: false,
    },
  })
  expect(await screen.findByText('primary')).toBeVisible()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), undefined, 'mac')
})

const peer: DeviceInfo = {
  id: 2,
  device_id: 'electron-peer',
  device_type: 'remote',
  name: 'Peer desktop',
  bind_shell: 'claudecode',
  status: 'online',
  is_default: false,
}
const peerEntry = {
  kind: 'identity' as const,
  deviceId: peer.device_id,
  profileId: '@primary',
  userId: '7',
  scheduled: false,
}

test.each([
  ['before', 'available'],
  ['after', 'available'],
  ['after', 'syncing'],
] as const)(
  'a first-use remote link keeps its target when the device arrives %s account lookup (%s catalog)',
  async (timing, nextStatus) => {
    let resolve!: (value: PersonalAssistantAccount | null) => void
    const lookup = new Promise<PersonalAssistantAccount | null>(done => {
      resolve = done
    })
    const { get, personalGet, initialize, changeDeviceCatalog } = setup(lookup, blank, undefined, {
      initialEntry: peerEntry,
      devices: [],
      deviceCatalogStatus: 'syncing',
      personalGet: async (userId, deviceId) => ({ ...blank, userId, executionDeviceId: deviceId }),
    })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    if (timing === 'after') {
      await act(async () => {
        resolve(null)
        await lookup
      })
      await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))
    }
    expect(initialize).not.toHaveBeenCalled()
    changeDeviceCatalog([peer], nextStatus)
    if (timing === 'before')
      await act(async () => {
        resolve(null)
        await lookup
      })
    expect(await screen.findByText('primary')).toBeVisible()
    expect(initialize.mock.calls).toEqual([[expect.any(String), undefined, peer.device_id]])
    expect(personalGet).toHaveBeenCalledWith(7, peer.device_id)
  }
)

test.each(['missing', 'denied'])(
  'an explicit remote link with a %s device cannot initialize on a different target',
  async reason => {
    const { initialize } = setup(null, blank, undefined, {
      initialEntry: peerEntry,
      devices: reason === 'missing' ? [] : [peer],
      deviceCatalogStatus: reason === 'missing' ? 'empty' : 'available',
      personalGet: async (userId, deviceId) => {
        if (deviceId === peer.device_id) throw new ApiError('Forbidden', 403)
        return { ...blank, userId, executionDeviceId: deviceId }
      },
    })
    expect(await screen.findByTestId('personal-assistant-account-retry')).toBeVisible()
    expect(initialize).not.toHaveBeenCalled()
    expect(screen.queryByText('primary')).toBeNull()
  }
)

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
          team: makeTeam('Default'),
          bot: { metadata: { ...account.defaultTeamRef, displayName: 'Default' } },
          ghost: { spec: { systemPrompt: 'Default instructions' } },
        },
        {
          roleId: role.id,
          team: makeTeam(role.name),
          bot: {
            metadata: { ...account.defaultTeamRef, displayName: role.name },
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
          team: makeTeam(role.name),
          bot: {
            metadata: { ...account.defaultTeamRef, displayName: role.name },
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
