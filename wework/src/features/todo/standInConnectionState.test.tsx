import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { newStandInPrimaryRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import {
  isStandInBindingOwner,
  type StandInExecutorApi,
  type StandInInboxWork,
  type StandInInstanceBinding,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'
import { createGitConnectionsModel } from './standInGitConnectionsModel'
import { hasConnectionDraft, rebaseConnectionDraft } from './standInConnectionSettingsModel'
import { useStandInInbox } from './useStandInInbox'
import { useStandInInstance } from './useStandInInstance'
import { effectiveProjectSource, updateProjectSource, type ProjectSource } from './standInProjects'
import { parseStandInEntry } from './standInEntry'
import { newStandInRole } from '@/api/personalStandIn'

const devices: DeviceInfo[] = []
const account = { userId: 1, backendUrl: 'https://current.example/api' }

it('restores the saved project draft after undoing scope edits on legacy roles', () => {
  const legacy: ProjectSource = {
    enabled: false,
    allProjects: true,
    projects: [],
    excludedProjects: [],
    tags: [],
  }
  expect(effectiveProjectSource(legacy).allProjects).toBe(false)
  const active = updateProjectSource(legacy, { includeIndependentIssues: true }, legacy)
  expect(active).toMatchObject({ enabled: true, allProjects: false })
  expect(updateProjectSource(active, { includeIndependentIssues: false }, legacy)).toBe(legacy)

  const scoped: ProjectSource = {
    ...legacy,
    enabled: true,
    excludedProjects: [
      { id: 'same', store: 'local' },
      { id: 'same', store: 'cloud' },
    ],
  }
  const all = updateProjectSource(scoped, { excludedProjects: [] }, scoped)
  expect(all.excludedProjects).toHaveLength(0)
  expect(
    updateProjectSource(all, { excludedProjects: [...scoped.excludedProjects].reverse() }, scoped)
  ).toBe(scoped)
})

it('adopts a refreshed DingTalk boundary after saving a project while retaining edited email', () => {
  const dingtalk = {
    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
    id: 'group',
    profile: 'test-account',
    name: 'Test group',
    kind: 'group',
    policy: { automatic: true, askBeforeAct: true },
    enabledAfter: '2026-11-27T08:00:00Z',
  }
  const original = {
    ...newStandInPrimaryRole('local'),
    connections: [dingtalk],
    enabledAfter: dingtalk.enabledAfter,
  }
  const mailbox = { ...dingtalk, providerId: 'email', id: 'inbox', kind: 'mailbox' }
  const draft = {
    ...original,
    prompt: 'Unsaved instructions',
    collaboration: { ...original.collaboration, allProjects: true, enabled: true },
    connections: [dingtalk, mailbox],
  }
  const accepted = {
    ...original,
    collaboration: draft.collaboration,
    enabledAfter: '2026-11-27T08:05:00Z',
    connections: [{ ...dingtalk, enabledAfter: '2026-11-27T08:05:00Z' }],
  }

  const remaining = rebaseConnectionDraft(draft, original, accepted, 'projects')

  expect(hasConnectionDraft(remaining, accepted, dingtalk.providerId)).toBe(false)
  expect(remaining.connections).toEqual([...accepted.connections, mailbox])
  expect(remaining.enabledAfter).toBe(accepted.enabledAfter)
  expect(remaining.prompt).toBe(draft.prompt)

  const unconnected = newStandInPrimaryRole('local')
  const savedProject = { ...unconnected, collaboration: accepted.collaboration }
  expect(rebaseConnectionDraft(savedProject, unconnected, savedProject, 'projects')).toStrictEqual(
    savedProject
  )
})

it('drops the active wizard on Back and changes the scope list only after Save', async () => {
  const initial = newStandInPrimaryRole('local')
  function Editor() {
    const navigation = useRef<StandInConnectionNavigationHandle>(null)
    const [draft, setDraft] = useState(initial)
    const [saved, setSaved] = useState(initial)
    return (
      <>
        <button type="button" onClick={() => navigation.current?.back()}>
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            setSaved(draft)
            navigation.current?.returnToScopeList()
          }}
        >
          Save
        </button>
        <StandInConnectionSettings
          ref={navigation}
          role={draft}
          savedConfiguration={saved}
          disabled={false}
          deviceId="local"
          localDeviceId="local"
          projects={[]}
          onChange={setDraft}
        />
      </>
    )
  }

  const user = userEvent.setup()
  render(<Editor />)
  await user.click(screen.getByTestId('stand-in-add-projects-connection'))
  const add = () => user.click(screen.getByTestId('stand-in-project-add-scope'))
  const all = () => user.click(screen.getByTestId('stand-in-all-projects'))
  const row = 'stand-in-project-open-scope-projects'

  await add()
  await all()
  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.queryByTestId(row)).not.toBeInTheDocument()
  await add()
  await all()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByTestId(row)).toBeVisible()
  await user.click(screen.getByTestId(`${row}-remove`))
  expect(screen.getByTestId(`${row}-pending-removal`)).toBeVisible()
  await user.click(screen.getByTestId(`${row}-undo-remove`))
  expect(screen.getByTestId(row)).toBeVisible()
  expect(screen.queryByTestId(`${row}-pending-removal`)).not.toBeInTheDocument()
})

it.each(['github', 'gitlab'])(
  'binds %s repository drafts to the authenticated account',
  async platform => {
    const providerId = '@wegent/dsh-connection-git/' + platform
    const account = {
      providerId,
      profile: JSON.stringify(['https://' + platform + '.com', '7']),
      id: 'personal',
      kind: 'personal',
      name: 'Test account',
    }
    const repository = { ...account, kind: 'repository', id: '42', name: 'team/repository' }
    const foreign = {
      ...repository,
      profile: JSON.stringify(['https://' + platform + '.com', '8']),
    }
    const search = vi
      .fn<StandInExecutorApi['searchConnectionResources']>()
      .mockResolvedValueOnce({ items: [account], hasMore: false })
      .mockResolvedValueOnce({ items: [foreign, repository], hasMore: false })
      .mockResolvedValueOnce({
        items: [],
        hasMore: false,
        availability: { status: 'auth_required' },
      })
    const onChange = vi.fn()
    const initial = { role: newStandInPrimaryRole('test-device'), disabled: false, onChange }
    const model = createGitConnectionsModel(
      { searchConnectionResources: search } as unknown as StandInExecutorApi,
      'test-device',
      providerId,
      initial
    )
    const unsubscribe = model.subscribe(() => {}, initial)
    try {
      await waitFor(() => expect(model.getSnapshot().accountStatus).toBe('ready'))
      model.set('kind', 'repository')
      await model.search()
      expect(model.getSnapshot().items).toEqual([repository])
      model.changeScope([], [foreign, repository])
      expect(onChange.mock.lastCall?.[0].connections).toEqual([expect.objectContaining(repository)])
      await model.search()
      expect(model.getSnapshot()).toMatchObject({
        accountStatus: 'signed_out',
        accounts: [],
        items: [],
      })
      model.changeScope([], [account])
      expect(onChange).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  }
)

it('restores a saved specific Git source instead of broadening it after reopening the draft', async () => {
  const providerId = '@wegent/dsh-connection-git/gitlab'
  const profile = JSON.stringify(['https://gitlab.com', '7'])
  const resource = { providerId, profile, id: '42', kind: 'repository', name: 'team/repo' }
  const saved = {
    ...resource,
    collectionKey: 'verified-issue-only',
    configurationSummary: 'Issue #2',
    policy: { automatic: false, askBeforeAct: true },
  }
  const search = vi
    .fn<StandInExecutorApi['searchConnectionResources']>()
    .mockResolvedValueOnce({ items: [{ ...resource, id: 'personal', kind: 'personal' }] })
    .mockResolvedValueOnce({ items: [resource] })
  const onChange = vi.fn()
  const initial = {
    role: newStandInPrimaryRole('test-device'),
    savedConnections: [saved],
    disabled: false,
    onChange,
  }
  const model = createGitConnectionsModel(
    { searchConnectionResources: search } as unknown as StandInExecutorApi,
    'test-device',
    providerId,
    initial
  )
  const unsubscribe = model.subscribe(() => {}, initial)
  try {
    await waitFor(() => expect(model.getSnapshot().accountStatus).toBe('ready'))
    model.set('kind', 'repository')
    await model.search()
    model.changeScope([], [resource])
    expect(onChange.mock.lastCall?.[0].connections).toEqual([saved])
    const previous = { ...saved, policy: { ...saved.policy, immediate: false } }
    const draft = { ...initial, role: { ...initial.role, connections: [previous] } }
    const leave = model.subscribe(() => {}, draft)
    try {
      model.changeScope([previous])
      model.changeScope([], [resource])
      expect(onChange.mock.lastCall?.[0].connections).toEqual([previous])
    } finally {
      leave()
    }
  } finally {
    unsubscribe()
  }
})

it('matches account IDs and preserves the installation-local owner', () => {
  expect(isStandInBindingOwner(1, 1)).toBe(true)
  expect(isStandInBindingOwner(1, 2)).toBe(false)
  expect(isStandInBindingOwner(1, 0)).toBe(false)
  expect(isStandInBindingOwner(0, 0)).toBe(true)
  expect(isStandInBindingOwner(0, 2)).toBe(true)
})

it.each([true, false])(
  'preserves the binding behavior for requireSetupConfirmation=%s',
  async requireSetupConfirmation => {
    const settings: PersonalStandInSettings = {
      version: 1,
      executionDeviceId: 'local',
      userId: account.userId,
      roles: [],
    }
    const binding = vi
      .fn<StandInExecutorApi['binding']>()
      .mockResolvedValueOnce({ status: 'unbound', version: 2, target: null })
      .mockResolvedValueOnce({
        status: 'activating',
        version: 3,
        target: { ...account, deviceId: 'local' },
      })
      .mockResolvedValueOnce({
        status: 'active',
        version: 4,
        target: { ...account, deviceId: 'local' },
      })
    const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>().mockResolvedValue(settings)
    const services = {
      standInApi: { binding, lifecycle, personalGet: async () => settings },
      getLocalRuntimeSidebarIdentity: async () =>
        ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useStandInInstance(services, account.userId, devices, true, true, account.backendUrl, {
        requireSetupConfirmation,
      })
    )

    if (requireSetupConfirmation) {
      await waitFor(() => expect(result.current.setupTarget?.deviceId).toBe('local'))
      expect(result.current.binding?.status).toBe('unbound')
      expect(binding.mock.calls).toEqual([['local']])
      expect(lifecycle).not.toHaveBeenCalled()
      await act(() => result.current.setup())
    }

    await waitFor(() => expect(result.current.binding?.status).toBe('active'))
    expect(binding.mock.calls.slice(1)).toEqual([
      ['local', 'prepareBind', 2, { ...account, deviceId: 'local' }],
      ['local', 'completeActivation', 3],
    ])
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith(account.userId, 'local', 'start')
  }
)

it.each([
  ['deviceId=local', 'local', undefined],
  ['deviceId=cloud&profileId=%40primary&settingsRequest=1', 'cloud', undefined],
  ['deviceId=other', undefined, 'forbidden'],
  ['deviceId=cloud&userId=2&settingsRequest=1', undefined, 'forbidden'],
  ['deviceId=cloud&profileId=missing&settingsRequest=1', undefined, 'not_found'],
  ['deviceId=cloud&profileId=reviewer&settingsRequest=1', 'cloud', undefined],
  ['deviceId=cloud', undefined, 'ambiguous'],
])(
  'resolves legacy link %s before binding an unbound assistant',
  async (query, expected, error) => {
    const settings: PersonalStandInSettings = {
      version: 0,
      executionDeviceId: 'local',
      userId: account.userId,
      roles: [],
    }
    const binding = vi
      .fn<StandInExecutorApi['binding']>()
      .mockResolvedValueOnce({ status: 'unbound', version: 0, target: null })
      .mockImplementationOnce(async (_id, _action, _version, target) => ({
        status: 'activating',
        version: 1,
        target: target ?? null,
      }))
      .mockResolvedValueOnce({
        status: 'active',
        version: 2,
        target: expected ? { ...account, deviceId: expected } : null,
      })
    const lifecycle = vi.fn(async () => settings)
    const personalGet = vi.fn(async (_userId: number, deviceId: string) => ({
      ...settings,
      executionDeviceId: deviceId,
      roles: deviceId === 'cloud' ? [newStandInRole(deviceId, 'reviewer')] : [],
    }))
    const services = {
      standInApi: { binding, lifecycle, personalGet },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
    } as unknown as WorkbenchServices
    const cloudDevices: DeviceInfo[] = [
      {
        id: 2,
        device_id: 'cloud',
        name: 'Cloud',
        device_type: 'cloud',
        bind_shell: 'claudecode',
        status: 'online',
        is_default: true,
      },
    ]
    const entry = parseStandInEntry(`/stand-in?${query}`)
    const { result } = renderHook(() =>
      useStandInInstance(services, account.userId, cloudDevices, true, true, account.backendUrl, {
        requireSetupConfirmation: false,
        entry,
      })
    )

    if (error) {
      await waitFor(() => expect(result.current.entryError).toBe(error))
      expect(result.current.binding?.status).toBe('unbound')
      expect(binding.mock.calls).toEqual([['local']])
      expect(lifecycle).not.toHaveBeenCalled()
      if (error === 'forbidden') expect(personalGet).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(result.current.binding?.status).toBe('active'))
      expect(result.current.binding?.target).toEqual({ ...account, deviceId: expected })
      expect(lifecycle).toHaveBeenCalledExactlyOnceWith(account.userId, expected, 'start')
    }
  }
)

it('keeps old inbox items hidden while the same owner and device load on a new connection', async () => {
  const item: StandInInboxWork = {
    id: 'work',
    taskId: 'task',
    roleId: 'role',
    title: 'First connection only',
    source: {
      providerId: 'test',
      id: 'source',
      profile: 'profile',
      name: 'Source',
      kind: 'message',
      policy: { automatic: false, askBeforeAct: true },
    },
    status: 'pending',
    updatedAt: '2026-11-18T00:00:00Z',
    messageCount: 0,
    latestMessage: null,
  }
  const inbox = vi
    .fn<StandInExecutorApi['inbox']>()
    .mockResolvedValueOnce({ items: [item], sourceErrors: [] })
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValueOnce({ items: [], sourceErrors: [] })
  const api = { inbox } as unknown as StandInExecutorApi
  const { result, rerender } = renderHook(
    ({ connection }) => useStandInInbox(api, 1, 'device', true, connection),
    { initialProps: { connection: 'https://first.example' } }
  )
  await waitFor(() => expect(result.current.items).toEqual([item]))

  rerender({ connection: 'https://second.example' })
  expect(result.current.items).toEqual([])
  expect(result.current.scope).toBeUndefined()

  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.scope).toBeDefined())
  expect(result.current.items).toEqual([])
})

it('reads legacy bindings without migration and only offers the stopped profile of the same user ID', async () => {
  const first: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'first',
    userId: 1,
    roles: [],
    lifecycle: { status: 'stopped' },
  }
  const binding = vi.fn<StandInExecutorApi['binding']>()
  const personalGet = vi
    .fn<StandInExecutorApi['personalGet']>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(first)
  const legacyTarget = {
    ...account,
    deviceId: 'first',
    username: 'previous-name',
    backendUrl: 'https://previous.example/api',
  }
  const original: StandInInstanceBinding = {
    status: 'stopped',
    version: 3,
    target: legacyTarget,
  }
  binding.mockResolvedValue(original)
  const services = {
    standInApi: { binding, personalGet } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } satisfies Partial<WorkbenchServices>
  const { result } = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      account.userId,
      devices,
      true,
      true,
      account.backendUrl
    )
  )
  await waitFor(() => expect(result.current.stoppedProfile).toBe(first))
  expect(result.current.binding).toEqual(original)
  expect(binding.mock.calls).toEqual([['local']])

  act(() => result.current.reload())
  expect(result.current.stoppedProfile).toBe(first)
  await waitFor(() => expect(personalGet).toHaveBeenCalledTimes(2))

  binding.mockResolvedValueOnce({
    status: 'stopped',
    version: 6,
    target: { ...account, deviceId: 'second' },
  })
  personalGet.mockRejectedValueOnce(new Error('Second device unavailable'))
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('second'))
  expect(result.current.stoppedProfile).toBeUndefined()
  await waitFor(() => expect(result.current.error).toBeTruthy())

  binding.mockResolvedValueOnce({
    status: 'stopped',
    version: 7,
    target: { ...account, userId: 2, deviceId: 'first' },
  })
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.version).toBe(7))
  expect(result.current.stoppedProfile).toBeUndefined()
  expect(personalGet).toHaveBeenCalledTimes(3)
})

it('keeps a recovered binding inactive until the destination acknowledges startup', async () => {
  const target = { ...account, deviceId: 'cloud' }
  const pending: StandInInstanceBinding = { status: 'activating', version: 4, target }
  const ready: StandInInstanceBinding = { ...pending, status: 'active', version: 5 }
  const profile: PersonalStandInSettings = {
    userId: account.userId,
    executionDeviceId: target.deviceId,
    version: 1,
    roles: [],
  }
  const binding = vi.fn<StandInExecutorApi['binding']>(async (_device, operation) =>
    operation === 'completeActivation' ? ready : pending
  )
  const lifecycle = vi
    .fn<StandInExecutorApi['lifecycle']>()
    .mockRejectedValueOnce(new Error('Activation acknowledgement lost'))
    .mockResolvedValue(profile)
  const services = {
    standInApi: { binding, lifecycle } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } satisfies Partial<WorkbenchServices>
  const { result } = renderHook(() =>
    useStandInInstance(services as WorkbenchServices, account.userId, devices, true, true)
  )

  await waitFor(() => expect(result.current.error).toBeTruthy())
  expect(result.current.binding).toEqual(pending)
  expect(binding.mock.calls).toEqual([['local']])

  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding).toEqual(ready))
  expect(result.current.error).toBeNull()
})

it.each(['runtime_rpc_timeout', 'unsupported_method', 'protocol_mismatch'])(
  'initializes the target device when stopping the old device reports %s',
  async code => {
    const source = { ...account, deviceId: 'remote' }
    const destination = { ...account, deviceId: 'local' }
    const pending: StandInInstanceBinding = {
      status: 'activating',
      version: 3,
      target: destination,
    }
    const ready: StandInInstanceBinding = { ...pending, status: 'active', version: 4 }
    const binding = vi
      .fn<StandInExecutorApi['binding']>()
      .mockResolvedValueOnce({ status: 'active', version: 1, target: source })
      .mockResolvedValueOnce({ status: 'stopping', version: 2, target: source })
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(ready)
    const settings = { userId: account.userId, executionDeviceId: 'local', version: 0, roles: [] }
    const lifecycle = vi
      .fn<StandInExecutorApi['lifecycle']>()
      .mockRejectedValueOnce({ code })
      .mockResolvedValueOnce(settings)
    const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(settings)
    const services = {
      standInApi: { binding, personalGet, lifecycle } as unknown as StandInExecutorApi,
      getLocalRuntimeSidebarIdentity: async () =>
        ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
    } satisfies Partial<WorkbenchServices>
    const { result } = renderHook(() =>
      useStandInInstance(services as WorkbenchServices, account.userId, devices, true, true)
    )
    await waitFor(() => expect(result.current.binding?.target).toEqual(source))

    const configure = vi.fn(async () => {})
    await act(async () => {
      expect(await result.current.initializeOnDevice(destination, configure)).toBe('initialized')
    })
    expect(configure).toHaveBeenCalledOnce()
    expect(lifecycle.mock.calls).toEqual([
      [account.userId, 'remote', 'stop'],
      [account.userId, 'local', 'start'],
    ])
    expect(result.current.binding).toEqual(ready)
  }
)
