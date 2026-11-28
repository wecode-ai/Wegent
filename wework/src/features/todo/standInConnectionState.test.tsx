import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { ApiError } from '@/api/http'
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
import { createStandInInstanceSource } from './standInInstanceSource'
import { effectiveProjectSource, updateProjectSource, type ProjectSource } from './standInProjects'
import { parseStandInEntry } from './standInEntry'
import { newStandInRole } from '@/api/personalStandIn'

const devices: DeviceInfo[] = []
const account = { userId: 1, backendUrl: 'https://current.example/api' }

const cloudDevice = (id: string, status: DeviceInfo['status'] = 'online'): DeviceInfo =>
  ({
    id: 1,
    device_id: id,
    name: id,
    device_type: 'cloud',
    status,
    is_default: id === 'cloud-1',
  }) as DeviceInfo

const makeAccount = (environmentId?: string, revision = 'rev-1'): PersonalAssistantAccount => ({
  defaultTeamRef: { name: 'primary-team', namespace: 'personal-assistant' },
  revision,
  retiredRoleIds: [],
  definitions: [
    {
      roleId: '@primary',
      team: {
        metadata: {
          name: 'primary-team',
          namespace: 'personal-assistant',
          displayName: '默认助理',
        },
        spec: {
          collaborationModel: 'solo',
          members: [
            { botRef: { name: 'primary', namespace: 'personal-assistant' }, role: 'leader' },
          ],
        },
      },
      bot: {
        metadata: { name: 'primary', namespace: 'personal-assistant', displayName: '默认助理' },
        spec: {
          execution_policy: environmentId
            ? { mode: 'fixed', environment_id: environmentId }
            : { mode: 'user_select' },
        },
      },
      ghost: {
        spec: { systemPrompt: 'Prompt' },
      },
    },
  ],
})

const makeBindingStore = () => {
  const stoppingTargets = new Set<string>()
  const generations: Record<string, number> = {}
  let nextGeneration = 0
  return vi.fn<StandInExecutorApi['binding']>(
    async (_deviceId, operation = 'get', version, target) => {
      if (operation === 'markStoppingWithGeneration' && target) {
        const key = `${target.userId}:${target.deviceId}`
        stoppingTargets.add(key)
        generations[key] = ++nextGeneration
      } else if (operation === 'clearStoppingIfGeneration' && target) {
        const key = `${target.userId}:${target.deviceId}`
        if (version !== generations[key])
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        stoppingTargets.delete(key)
        delete generations[key]
      }
      return {
        version: 0,
        status: 'unbound',
        target: null,
        stoppingTargets: [...stoppingTargets],
        stoppingTargetGenerations: { ...generations },
      } satisfies StandInInstanceBinding
    }
  )
}

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

it('shares cloud primary execution device across clients and falls back cleanly for foreign local desktop IDs', async () => {
  const foreignDesktopId = `electron-${'a'.repeat(64)}`
  let currentDesktopId = `electron-${'b'.repeat(64)}`
  let freshAccount = makeAccount('cloud-1')
  const getAccount = vi.fn(async () => freshAccount)
  const emptyLocal: PersonalStandInSettings = {
    version: 0,
    executionDeviceId: currentDesktopId,
    userId: 1,
    roles: [],
  }
  const activeCloud: PersonalStandInSettings = {
    version: 2,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const personalGet = vi
    .fn<StandInExecutorApi['personalGet']>()
    .mockImplementation(async (_userId, deviceId) =>
      deviceId === 'cloud-1' ? activeCloud : emptyLocal
    )
  const updateDefinitions = vi.fn()
  const services = {
    standInApi: { personalGet, binding: makeBindingStore() } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      updateDefinitions,
      get: getAccount,
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: currentDesktopId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>
  const devices = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]

  const { result, rerender } = renderHook(
    ({ account, userId, devices }) =>
      useStandInInstance(
        services as WorkbenchServices,
        userId,
        devices,
        true,
        true,
        'https://cloud.example/api',
        { account, accountNavigationOnly: true, newAccount: true }
      ),
    { initialProps: { account: freshAccount, userId: 1, devices } }
  )

  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))
  expect(result.current.binding?.status).toBe('active')
  expect(result.current.setupTarget).toBeUndefined()

  // When another desktop saved its private electron-* IPC ID (either current sha256 or legacy UUID),
  // this client resolves an available cloud device without overwriting the other desktop's setting.
  freshAccount = makeAccount(`electron-${'c'.repeat(64)}`)
  rerender({ account: freshAccount, userId: 1, devices: [] })
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe(currentDesktopId))
  rerender({ account: freshAccount, userId: 1, devices })
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))

  for (const desktopId of [foreignDesktopId, 'electron-11111111-1111-4111-8111-111111111111']) {
    const previousVersion = result.current.binding!.version
    freshAccount = makeAccount(desktopId)
    rerender({ account: freshAccount, userId: 1, devices })
    await waitFor(() => expect(result.current.binding?.version).toBeGreaterThan(previousVersion))
    expect(result.current.binding?.target?.deviceId).toBe('cloud-1')
    expect(updateDefinitions).not.toHaveBeenCalled()
  }

  // A configured local alias follows the current IPC identity, even when the account is unchanged.
  freshAccount = makeAccount('local-device')
  rerender({ account: freshAccount, userId: 1, devices })
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe(currentDesktopId))
  currentDesktopId = `electron-${'d'.repeat(64)}`
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe(currentDesktopId))

  // A fresh account response and a newly registered peer both invalidate the old pin.
  freshAccount = makeAccount(foreignDesktopId, 'rev-2')
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))
  rerender({
    account: freshAccount,
    userId: 1,
    devices: [...devices, cloudDevice(foreignDesktopId)],
  })
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe(foreignDesktopId))
  freshAccount = makeAccount('cloud-2', 'rev-3')
  getAccount.mockClear()
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-2'))
  expect(getAccount).toHaveBeenCalledTimes(1)

  freshAccount = makeAccount(undefined, 'rev-4')
  act(() => result.current.reload())
  await waitFor(() =>
    expect(result.current.binding).toMatchObject({ status: 'unbound', target: null })
  )
  expect(result.current.setupTarget).toBeUndefined()
  freshAccount = makeAccount('cloud-2', 'rev-5')

  const denied = new ApiError('Access denied', 403)
  getAccount.mockRejectedValueOnce(denied)
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.errorCause).toBe(denied))
  expect(result.current.binding).toBeUndefined()
  expect(result.current.setupTarget).toBeUndefined()
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-2'))

  // Switching accounts immediately resolves the new account without owner-mismatch lockouts.
  rerender({ account: freshAccount, userId: 2, devices })
  await waitFor(() =>
    expect(result.current.binding?.target).toEqual({
      userId: 2,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
})

it('retires a prepared account activation when the chosen device disconnects before start', async () => {
  const configured = makeAccount('cloud-1')
  let saved: StandInInstanceBinding = { version: 0, status: 'unbound', target: null }
  let releasePreparation!: () => void
  const preparing = new Promise<void>(resolve => {
    releasePreparation = resolve
  })
  const binding = vi.fn<StandInExecutorApi['binding']>(
    async (_device, operation = 'get', version, target) => {
      if (operation === 'prepareBind') {
        saved = { version: 1, status: 'activating', target: target! }
        await preparing
      } else if (operation === 'cancelActivation') {
        expect(version).toBe(1)
        expect(target).toEqual(saved.target)
        saved = { version: 2, status: 'unbound', target: null }
      }
      return saved
    }
  )
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  const services = {
    standInApi: {
      binding,
      lifecycle,
      personalGet: async () => ({ version: 1, executionDeviceId: 'cloud-1', userId: 1, roles: [] }),
    },
    personalAssistantAccountApi: { get: async () => configured },
    getLocalRuntimeSidebarIdentity: async () => ({
      deviceId: 'local',
      runtimeInstanceId: 'instance',
      provenance: 'local-ipc',
    }),
  } as unknown as WorkbenchServices
  const { result, rerender } = renderHook(
    ({ connected, devices }) =>
      useStandInInstance(services, 1, devices, connected, true, 'https://cloud.example/api', {
        account: configured,
        newAccount: true,
      }),
    {
      initialProps: { connected: true, devices: [cloudDevice('cloud-1')] },
    }
  )
  await waitFor(() => expect(result.current.setupTarget?.deviceId).toBe('cloud-1'))
  let setup!: Promise<unknown>
  act(() => {
    setup = result.current.setup()
  })
  try {
    await waitFor(() =>
      expect(binding).toHaveBeenCalledWith(
        'local',
        'prepareBind',
        0,
        expect.objectContaining({ deviceId: 'cloud-1' })
      )
    )
    rerender({ connected: false, devices: [cloudDevice('cloud-1', 'offline')] })
  } finally {
    await act(async () => {
      releasePreparation()
      await setup
    })
  }
  await waitFor(() => expect(saved.status).toBe('unbound'))
  expect(lifecycle).not.toHaveBeenCalled()
  expect(binding).toHaveBeenCalledWith(
    'local',
    'cancelActivation',
    1,
    expect.objectContaining({ deviceId: 'cloud-1' })
  )
})

it('does not retire a new account preparation using a stale binding read', async () => {
  const configured = makeAccount('cloud-1')
  let latest = configured
  let saved: StandInInstanceBinding = { version: 0, status: 'unbound', target: null }
  const holdRead = Promise.withResolvers<void>()
  const staleReadStarted = Promise.withResolvers<void>()
  const confirm = Promise.withResolvers<PersonalAssistantAccount>()
  const confirmationStarted = Promise.withResolvers<void>()
  let holdNextGet = false
  let confirmNextAccount = false
  const binding = vi.fn<StandInExecutorApi['binding']>(
    async (_device, operation = 'get', version, target) => {
      if (operation === 'get' && holdNextGet) {
        holdNextGet = false
        const captured = saved
        staleReadStarted.resolve()
        await holdRead.promise
        return captured
      }
      if (operation === 'prepareBind') {
        saved = { version: 1, status: 'activating', target: target! }
        confirmNextAccount = true
      } else if (operation === 'cancelActivation') {
        expect(version).toBe(saved.version)
        expect(target).toEqual(saved.target)
        saved = { version: 2, status: 'unbound', target: null }
      }
      return saved
    }
  )
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  const services = {
    standInApi: {
      binding,
      lifecycle,
      personalGet: async (_owner: number, deviceId: string) => ({
        userId: 1,
        executionDeviceId: deviceId,
        version: 1,
        roles: [],
      }),
    },
    personalAssistantAccountApi: {
      get: async () => {
        if (confirmNextAccount) {
          confirmNextAccount = false
          confirmationStarted.resolve()
          return confirm.promise
        }
        return latest
      },
    },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
  } as unknown as WorkbenchServices
  const source = createStandInInstanceSource({
    services,
    api: services.standInApi,
    userId: 1,
    backendUrl: account.backendUrl,
    accountMode: true,
  })
  const unsubscribe = source.subscribe(
    {
      account: configured,
      newAccount: true,
      active: true,
      connected: true,
      devices: [cloudDevice('cloud-1'), cloudDevice('cloud-2')],
    },
    () => {}
  )
  let setup: Promise<boolean> | undefined
  try {
    await waitFor(() => expect(source.getSnapshot().setupTarget?.deviceId).toBe('cloud-1'))
    holdNextGet = true
    source.reload()
    await staleReadStarted.promise
    setup = source.setup()
    await confirmationStarted.promise
    // The binding was prepared after the read captured an unbound row.
    await act(async () => holdRead.resolve())
    latest = makeAccount('cloud-2', 'rev-2')
    confirm.resolve(latest)
    await setup
    expect(saved.status).toBe('unbound')
    expect(binding).toHaveBeenCalledWith(
      'local',
      'cancelActivation',
      1,
      expect.objectContaining({ deviceId: 'cloud-1' })
    )
    expect(lifecycle).not.toHaveBeenCalled()
  } finally {
    holdRead.resolve()
    confirm.resolve(latest)
    await setup
    unsubscribe()
  }
})

it('does not activate a local preparation after the original subscriber leaves', async () => {
  let saved: StandInInstanceBinding = { version: 0, status: 'unbound', target: null }
  const preparationStarted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const binding = vi.fn<StandInExecutorApi['binding']>(
    async (_device, operation = 'get', version, target) => {
      if (operation === 'prepareBind') {
        saved = { version: 1, status: 'activating', target: target! }
        preparationStarted.resolve()
        await release.promise
      } else if (operation === 'cancelActivation') {
        expect(version).toBe(1)
        expect(target).toEqual(saved.target)
        saved = { version: 2, status: 'unbound', target: null }
      } else if (operation === 'completeActivation') {
        saved = { version: 2, status: 'active', target: saved.target }
      }
      return saved
    }
  )
  const profile = { userId: 1, executionDeviceId: 'local', version: 1, roles: [] }
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>().mockResolvedValue(profile)
  const services = {
    standInApi: { binding, lifecycle, personalGet: async () => profile },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
  } as unknown as WorkbenchServices
  const source = createStandInInstanceSource({
    services,
    api: services.standInApi,
    userId: 1,
    backendUrl: account.backendUrl,
  })
  const owner = { active: true, connected: true, devices: [] }
  const unsubscribe = source.subscribe(owner, () => {})
  let nextUnsubscribe: (() => void) | undefined
  let setup: Promise<boolean> | undefined
  try {
    await waitFor(() => expect(source.getSnapshot().setupTarget?.deviceId).toBe('local'))
    setup = source.setup()
    await preparationStarted.promise
    unsubscribe()
    // Wait for ownership teardown before subscribing again, while the committed
    // prepareBind response is still blocked.
    await Promise.resolve()
    await act(async () => {
      nextUnsubscribe = source.subscribe(owner, () => {})
    })
    expect(lifecycle).not.toHaveBeenCalled()
    release.resolve()
    await setup
    await waitFor(() =>
      expect(source.getSnapshot().binding).toMatchObject({ status: 'unbound', version: 2 })
    )
    expect(saved.status).toBe('unbound')
    expect(binding).toHaveBeenCalledWith(
      'local',
      'cancelActivation',
      1,
      expect.objectContaining({ deviceId: 'local' })
    )
    expect(lifecycle).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    await setup
    nextUnsubscribe?.()
  }
})

it('switches primary execution device directly without stopping and allows switching away while an offline device stops', async () => {
  const localId = `electron-${'c'.repeat(64)}`
  let latestAccount = makeAccount('cloud-1', 'rev-1')
  const runningCloud: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(runningCloud)
  const lifecycle = vi
    .fn<StandInExecutorApi['lifecycle']>()
    .mockResolvedValueOnce(runningCloud)
    .mockRejectedValueOnce(new Error('executor-offline:cloud-2'))
    .mockResolvedValueOnce({ ...runningCloud, executionDeviceId: localId })
  const updateDefinitions = vi.fn(async (_revision, definitions) => {
    const nextDevice = definitions.find(
      (entry: { roleId: string }) => entry.roleId === '@primary'
    )?.executionDeviceId
    latestAccount = {
      ...makeAccount(nextDevice, 'rev-2'),
      stopIntents: latestAccount.stopIntents,
      stopIntentGenerations: latestAccount.stopIntentGenerations,
    }
    return latestAccount
  })
  const publishAccount = vi.fn((next: PersonalAssistantAccount) => {
    latestAccount = next
  })
  const binding = makeBindingStore()
  const getAccount = vi.fn(async () => latestAccount)
  const updateStopIntent = vi.fn(
    async (
      deviceId: string,
      operation: 'mark' | 'clear',
      requestId: string,
      expectedRequestId?: string | null,
      expectedVersion?: number
    ) => {
      const intents = latestAccount.stopIntents ?? []
      if (operation === 'mark') {
        expect(expectedRequestId).toBe(latestAccount.stopIntentGenerations?.[deviceId] ?? null)
      }
      latestAccount = {
        ...latestAccount,
        stopIntentGenerations:
          operation === 'mark'
            ? { ...latestAccount.stopIntentGenerations, [deviceId]: requestId }
            : latestAccount.stopIntentGenerations,
        stopIntents:
          operation === 'mark'
            ? [
                ...intents.filter(intent => intent.deviceId !== deviceId),
                { deviceId, requestId, expectedVersion },
              ]
            : intents.filter(intent => intent.deviceId !== deviceId),
      }
      return latestAccount
    }
  )
  const services = {
    standInApi: { personalGet, lifecycle, binding } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      updateDefinitions,
      get: getAccount,
      updateStopIntent,
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: localId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>
  const devices = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]

  const { result } = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      1,
      devices,
      true,
      true,
      'https://cloud.example/api',
      {
        account: latestAccount,
        publishAccount,
        readAccount: () => latestAccount,
        requireSetupConfirmation: false,
      }
    )
  )

  await waitFor(() => expect(result.current.binding?.target?.deviceId).toBe('cloud-1'))

  // Switch directly from cloud-1 to cloud-2 without stopping cloud-1.
  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
  expect(lifecycle).toHaveBeenCalledWith(1, 'cloud-2', 'start', runningCloud.version)
  expect(
    lifecycle.mock.calls.some(([, device, action]) => device === 'cloud-1' && action === 'stop')
  ).toBe(false)
  expect(result.current.binding?.target?.deviceId).toBe('cloud-2')

  // A failed cloud marker write cannot create a falsely recorded stop intent.
  const persistenceFailure = new Error('Stop marker storage unavailable')
  updateStopIntent.mockRejectedValueOnce(persistenceFailure)
  await act(async () => expect(await result.current.stop()).toBe(false))
  expect(updateStopIntent).toHaveBeenLastCalledWith(
    'cloud-2',
    'mark',
    expect.any(String),
    null,
    runningCloud.version
  )
  expect(latestAccount.stopIntents ?? []).toEqual([])
  expect(result.current.errorCause).toBe(persistenceFailure)
  expect(result.current.binding?.status).toBe('active')
  expect(
    lifecycle.mock.calls.some(([, device, action]) => device === 'cloud-2' && action === 'stop')
  ).toBe(false)

  // Offline stop failure keeps cloud-2 in stopping, while allowing switching to localId.
  await act(async () => expect(await result.current.stop()).toBe(true))
  expect(result.current.binding?.status).toBe('stopping')

  expect(result.current.binding?.target?.deviceId).toBe('cloud-2')

  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: localId,
    })
  )
  expect(result.current.binding).toMatchObject({
    status: 'active',
    target: { userId: 1, deviceId: localId },
  })

  // The local Executor can still stop its own assistant during an account-service outage.
  const localIntent = { deviceId: localId, requestId: 'peer-stop-local' }
  latestAccount = {
    ...latestAccount,
    stopIntents: [...(latestAccount.stopIntents ?? []), localIntent],
    stopIntentGenerations: {
      ...latestAccount.stopIntentGenerations,
      [localId]: localIntent.requestId,
    },
  }
  getAccount.mockRejectedValue(new Error('Account service unavailable'))
  const stoppedLocal: PersonalStandInSettings = {
    ...runningCloud,
    executionDeviceId: localId,
    lifecycle: { status: 'stopped' },
  }
  lifecycle.mockImplementationOnce(async () => {
    personalGet.mockImplementation(async (_user, deviceId) =>
      deviceId === localId ? stoppedLocal : runningCloud
    )
    return stoppedLocal
  })
  await act(() => result.current.stop())
  expect(result.current.binding?.status).toBe('stopped')
  expect(lifecycle).toHaveBeenLastCalledWith(1, localId, 'stop')
  expect(latestAccount.stopIntents).toContainEqual(localIntent)
  getAccount.mockImplementation(async () => latestAccount)
  lifecycle.mockResolvedValueOnce(stoppedLocal)
  act(() => result.current.reload())
  await waitFor(() => expect(latestAccount.stopIntents).not.toContainEqual(localIntent))

  // Selecting cloud-2 again cannot resume a device with an unconfirmed stop.
  lifecycle.mockClear()
  await act(() =>
    result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-2',
    })
  )
  expect(result.current.binding).toMatchObject({
    status: 'stopping',
    target: { userId: 1, deviceId: 'cloud-2' },
  })
  expect(lifecycle).not.toHaveBeenCalled()

  // A failed local read must retain the known stopping state and expose its error.
  binding.mockRejectedValueOnce(persistenceFailure)
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.errorCause).toBe(persistenceFailure))
  expect(result.current.binding?.status).toBe('stopping')
  act(() => result.current.reload())
  await waitFor(() => expect(result.current.error).toBeNull())
  expect(result.current.binding?.status).toBe('stopping')

  // A failed start may not convert a verified stopped destination into active.
  const stoppedCloud1: PersonalStandInSettings = {
    ...runningCloud,
    lifecycle: { status: 'stopped' },
    version: 3,
  }
  personalGet.mockImplementation(async (_user, deviceId) =>
    deviceId === 'cloud-1' ? stoppedCloud1 : { ...runningCloud, executionDeviceId: deviceId }
  )
  const startFailure = new Error('Start acknowledgement unavailable')
  lifecycle.mockRejectedValueOnce(startFailure)
  await expect(
    act(() =>
      result.current.bind({
        userId: 1,
        backendUrl: 'https://cloud.example/api',
        deviceId: 'cloud-1',
      })
    )
  ).rejects.toBe(startFailure)
  expect(result.current.binding).toMatchObject({
    status: 'stopped',
    target: { deviceId: 'cloud-1' },
  })
  expect(result.current.errorCause).toBe(startFailure)
})

it('shares offline stopping state across clients, guards stale stops, and recovers from revision conflicts', async () => {
  const localId = 'electron-22222222-2222-4222-8222-222222222222'
  let latestAccount = makeAccount('cloud-1', 'rev-1')
  const clearFailure = new Error('Stop marker cleanup unavailable')
  let failClear = false
  const runningProfile: PersonalStandInSettings = {
    version: 1,
    executionDeviceId: 'cloud-1',
    userId: 1,
    roles: [],
  }
  const restartedProfile = { ...runningProfile, version: 2, executionDeviceId: 'cloud-2' }
  const personalGet = vi
    .fn<StandInExecutorApi['personalGet']>()
    .mockImplementation(async (_user, device) => ({ ...runningProfile, executionDeviceId: device }))
  const binding = makeBindingStore()
  const updateStopIntent = vi.fn(
    async (
      deviceId: string,
      operation: 'mark' | 'clear',
      requestId: string,
      expectedRequestId?: string | null,
      expectedVersion?: number
    ) => {
      const intents = latestAccount.stopIntents ?? []
      const previous = intents.find(intent => intent.deviceId === deviceId)
      if (operation === 'clear' && failClear) throw clearFailure
      if (operation === 'mark') {
        expect(expectedRequestId).toBe(latestAccount.stopIntentGenerations?.[deviceId] ?? null)
        if (!previous) {
          // The target may restart while the first marker request is in flight.
          personalGet.mockImplementation(async (_user, device) =>
            device === 'cloud-2'
              ? restartedProfile
              : { ...runningProfile, executionDeviceId: device }
          )
        }
      }
      latestAccount = {
        ...latestAccount,
        stopIntentGenerations:
          operation === 'mark'
            ? {
                ...latestAccount.stopIntentGenerations,
                [deviceId]: requestId,
              }
            : latestAccount.stopIntentGenerations,
        stopIntents:
          operation === 'mark'
            ? [
                ...intents.filter(intent => intent.deviceId !== deviceId),
                { deviceId, requestId, expectedVersion },
              ]
            : intents.filter(
                intent => intent.deviceId !== deviceId || intent.requestId !== requestId
              ),
      }
      return latestAccount
    }
  )
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  const getAccount = vi.fn(async () => latestAccount)
  let conflictOnce = true
  const updateDefinitions = vi.fn(async (revision: string, definitions) => {
    if (conflictOnce && revision !== latestAccount.revision) {
      conflictOnce = false
      throw Object.assign(new Error('Conflict'), { status: 409, code: 'version_conflict' })
    }
    const nextDevice = definitions.find(
      (entry: { roleId: string }) => entry.roleId === '@primary'
    )?.executionDeviceId
    latestAccount = makeAccount(nextDevice, `${latestAccount.revision}-next`)
    return latestAccount
  })
  const publishAccount = vi.fn((next: PersonalAssistantAccount) => {
    latestAccount = next
  })
  const services = {
    standInApi: { personalGet, lifecycle, binding } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: {
      get: getAccount,
      updateDefinitions,
      updateStopIntent,
    } as unknown as NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
    getLocalRuntimeSidebarIdentity: async () =>
      ({
        deviceId: localId,
        runtimeInstanceId: 'instance',
        provenance: 'local-ipc',
      }) as const,
  } satisfies Partial<WorkbenchServices>

  const onlineDevices = [cloudDevice('cloud-1', 'online'), cloudDevice('cloud-2', 'online')]
  const offlineCloud2Devices = [cloudDevice('cloud-1', 'online'), cloudDevice('cloud-2', 'offline')]
  const firstMount = renderHook(
    ({ account, devices }) =>
      useStandInInstance(
        services as WorkbenchServices,
        1,
        devices,
        true,
        true,
        'https://cloud.example/api',
        {
          account,
          publishAccount,
          readAccount: () => latestAccount,
          requireSetupConfirmation: false,
        }
      ),
    {
      initialProps: {
        account: latestAccount,
        devices: onlineDevices,
      },
    }
  )
  await waitFor(() => expect(firstMount.result.current.binding?.target?.deviceId).toBe('cloud-1'))

  // Another client switches @primary to cloud-2 before stop is confirmed on this client.
  const staleStopTarget = firstMount.result.current.binding!.target!
  latestAccount = makeAccount('cloud-2', 'rev-2')
  await act(async () => expect(await firstMount.result.current.stop(staleStopTarget)).toBe(false))
  expect(lifecycle).not.toHaveBeenCalled()
  await waitFor(() => expect(firstMount.result.current.binding?.target?.deviceId).toBe('cloud-2'))

  // Both clients keep their independent local binding stores while cloud-2 is offline.
  firstMount.rerender({
    account: latestAccount,
    devices: offlineCloud2Devices,
  })
  const peerServices = {
    ...services,
    standInApi: {
      personalGet,
      lifecycle,
      binding: makeBindingStore(),
    } as unknown as StandInExecutorApi,
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'electron-peer', runtimeInstanceId: 'peer', provenance: 'local-ipc' }) as const,
  }
  const afterReload = renderHook(
    ({ account, devices }) =>
      useStandInInstance(
        peerServices as WorkbenchServices,
        1,
        devices,
        true,
        true,
        'https://cloud.example/api',
        {
          account,
          publishAccount,
          readAccount: () => latestAccount,
          requireSetupConfirmation: false,
        }
      ),
    {
      initialProps: {
        account: latestAccount,
        devices: offlineCloud2Devices,
      },
    }
  )
  await waitFor(() => expect(afterReload.result.current.binding?.status).toBe('unavailable'))
  // The offline stop persists account state before delivery. Refreshing only the
  // account on an already-open peer must reveal it without changing definitions.
  lifecycle.mockRejectedValueOnce(new Error('executor-offline:cloud-2'))
  await act(() => firstMount.result.current.stop(firstMount.result.current.binding!.target!))
  expect(firstMount.result.current.binding?.status).toBe('stopping')
  const intent = latestAccount.stopIntents?.[0]
  expect(intent).toMatchObject({
    deviceId: 'cloud-2',
    requestId: expect.any(String),
    expectedVersion: runningProfile.version,
  })
  expect(binding).not.toHaveBeenCalledWith(
    localId,
    'markStoppingWithGeneration',
    undefined,
    expect.anything()
  )
  expect(lifecycle).toHaveBeenLastCalledWith(1, 'cloud-2', 'stop', runningProfile.version)
  firstMount.unmount()
  afterReload.rerender({ account: latestAccount, devices: offlineCloud2Devices })
  await waitFor(() => expect(afterReload.result.current.binding?.status).toBe('stopping'))

  // Cloud-2 comes back online before receiving stop: status must remain 'stopping' until stop completes.
  personalGet.mockClear()
  const beforeReconnectVersion = afterReload.result.current.binding!.version
  afterReload.rerender({
    account: latestAccount,
    devices: onlineDevices,
  })
  await waitFor(() =>
    expect(personalGet).toHaveBeenCalledWith(1, 'cloud-2', { deviceSettingsOnly: true })
  )
  await waitFor(() =>
    expect(afterReload.result.current.binding!.version).toBeGreaterThan(beforeReconnectVersion)
  )
  expect(afterReload.result.current.binding?.status).toBe('stopping')
  expect(latestAccount.stopIntents).toEqual([intent])

  const stoppedProfile: PersonalStandInSettings = {
    ...restartedProfile,
    version: 3,
    executionDeviceId: 'cloud-2',
    lifecycle: { status: 'stopped' },
  }
  lifecycle.mockResolvedValueOnce(stoppedProfile)
  failClear = true
  await act(() => afterReload.result.current.stop(afterReload.result.current.binding!.target!))
  expect(afterReload.result.current.binding?.status).toBe('stopped')
  expect(afterReload.result.current.errorCause).toBe(clearFailure)
  expect(lifecycle).toHaveBeenLastCalledWith(1, 'cloud-2', 'stop', restartedProfile.version)
  expect(latestAccount.stopIntents?.[0]).toMatchObject({
    expectedVersion: restartedProfile.version,
  })
  expect(latestAccount.stopIntents?.[0].requestId).not.toBe(intent?.requestId)

  // A verified remote stop remains stopped even if cleanup failed; reload retries the account cleanup.
  failClear = false
  personalGet.mockResolvedValueOnce(stoppedProfile)
  lifecycle.mockResolvedValueOnce(stoppedProfile)
  act(() => afterReload.result.current.reload())
  await waitFor(() => expect(latestAccount.stopIntents).toEqual([]))
  expect(afterReload.result.current.binding?.status).toBe('stopped')
  expect(afterReload.result.current.error).toBeNull()
  const verifiedStoppedVersion = afterReload.result.current.binding!.version
  afterReload.rerender({ account: latestAccount, devices: offlineCloud2Devices })
  await waitFor(() =>
    expect(afterReload.result.current.binding!.version).toBeGreaterThan(verifiedStoppedVersion)
  )
  expect(afterReload.result.current.binding?.status).toBe('stopped')
  expect(afterReload.result.current.error).not.toBeNull()
  afterReload.unmount()

  // Simulate another client advancing revision to rev-3; first bind fails with 409 and refreshes latestAccount,
  // so retrying bind immediately succeeds with rev-3.
  const staleAccountSnapshot = latestAccount
  let clientAccount = staleAccountSnapshot
  const publishRefreshedAccount = vi.fn((next: PersonalAssistantAccount) => {
    clientAccount = next
    publishAccount(next)
  })
  publishAccount.mockClear()
  const conflictMount = renderHook(() =>
    useStandInInstance(
      services as WorkbenchServices,
      1,
      onlineDevices,
      true,
      true,
      'https://cloud.example/api',
      {
        account: clientAccount,
        publishAccount: publishRefreshedAccount,
        readAccount: () => clientAccount,
        requireSetupConfirmation: false,
      }
    )
  )
  await waitFor(() =>
    expect(conflictMount.result.current.binding?.target?.deviceId).toBe('cloud-2')
  )
  latestAccount = makeAccount('cloud-2', 'rev-3')
  await expect(
    act(() =>
      conflictMount.result.current.bind({
        userId: 1,
        backendUrl: 'https://cloud.example/api',
        deviceId: 'cloud-1',
      })
    )
  ).rejects.toMatchObject({ status: 409 })
  expect(publishAccount).toHaveBeenCalledWith(expect.objectContaining({ revision: 'rev-3' }))
  lifecycle.mockResolvedValueOnce(runningProfile)
  await act(() =>
    conflictMount.result.current.bind({
      userId: 1,
      backendUrl: 'https://cloud.example/api',
      deviceId: 'cloud-1',
    })
  )
  expect(updateDefinitions).toHaveBeenLastCalledWith('rev-3', expect.any(Array))
  expect(conflictMount.result.current.binding?.target?.deviceId).toBe('cloud-1')

  // A peer can change the configured device during a stop without changing its marker.
  latestAccount = {
    ...latestAccount,
    stopIntents: [
      { deviceId: 'cloud-1', requestId: 'peer-confirmed', expectedVersion: runningProfile.version },
    ],
    stopIntentGenerations: { 'cloud-1': 'peer-confirmed' },
  }
  clientAccount = latestAccount
  conflictMount.rerender()
  await waitFor(() => expect(conflictMount.result.current.binding?.status).toBe('stopping'))
  let finishStop!: (profile: PersonalStandInSettings) => void
  lifecycle.mockReturnValueOnce(
    new Promise(resolve => {
      finishStop = resolve
    })
  )
  let stopping!: Promise<boolean>
  act(() => {
    stopping = conflictMount.result.current.stop()
  })
  try {
    await waitFor(() =>
      expect(lifecycle).toHaveBeenLastCalledWith(1, 'cloud-1', 'stop', runningProfile.version)
    )
    latestAccount = {
      ...makeAccount('cloud-2', 'rev-4'),
      stopIntents: latestAccount.stopIntents,
      stopIntentGenerations: latestAccount.stopIntentGenerations,
    }
    clientAccount = latestAccount
    conflictMount.rerender()
  } finally {
    await act(async () => {
      finishStop({ ...runningProfile, version: 2, lifecycle: { status: 'stopped' } })
      await stopping
    })
  }
  await waitFor(() =>
    expect(conflictMount.result.current.binding?.target?.deviceId).toBe('cloud-2')
  )
  expect(conflictMount.result.current.binding?.status).toBe('active')
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

it('recovers an unavailable legacy source without reattaching the native binding', async () => {
  const source = { ...account, deviceId: 'remote' }
  const destination = { ...account, deviceId: 'local' }
  const sourceBinding: StandInInstanceBinding = {
    status: 'activating',
    version: 1,
    target: source,
  }
  const stoppingBinding: StandInInstanceBinding = {
    ...sourceBinding,
    status: 'stopping',
    version: 2,
  }
  const settings: PersonalStandInSettings = {
    executionDeviceId: destination.deviceId,
    userId: destination.userId,
    version: 5,
    roles: [],
    lifecycle: { status: 'stopped' },
  }
  const binding = vi
    .fn<StandInExecutorApi['binding']>()
    .mockResolvedValueOnce(sourceBinding)
    .mockResolvedValueOnce(stoppingBinding)
    .mockResolvedValueOnce(stoppingBinding)
  const lifecycle = vi
    .fn<StandInExecutorApi['lifecycle']>()
    .mockRejectedValueOnce({ code: 'runtime_rpc_timeout' })
    .mockResolvedValueOnce({ ...settings, version: 6, lifecycle: undefined })
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(settings)
  const services = {
    standInApi: { binding, lifecycle, personalGet } as unknown as StandInExecutorApi,
    personalAssistantAccountApi: { get: async () => makeAccount('remote') },
    getLocalRuntimeSidebarIdentity: async () =>
      ({ deviceId: 'local', runtimeInstanceId: 'instance', provenance: 'local-ipc' }) as const,
  } as unknown as WorkbenchServices
  const { result } = renderHook(() =>
    useStandInInstance(services, account.userId, devices, true, true, account.backendUrl, {
      legacyOnly: true,
    })
  )
  await waitFor(() => expect(result.current.binding).toEqual(sourceBinding))
  expect(lifecycle).not.toHaveBeenCalled()
  const configure = vi.fn(async () => {})
  await act(async () => {
    expect(await result.current.initializeOnDevice(destination, configure)).toBe('initialized')
  })
  expect(binding.mock.calls).toEqual([['local'], ['local', 'beginStop', 1], ['local', 'get']])
  expect(lifecycle.mock.calls).toEqual([
    [account.userId, 'remote', 'stop'],
    [account.userId, 'local', 'start', 5],
  ])
  expect(configure).toHaveBeenCalledOnce()
  expect(result.current.binding).toEqual(stoppingBinding)
})

it.each(['retry', 'read'] as const)(
  'retains a stop marker when the stopped version changes before %s verifies it',
  async mode => {
    const stopped: PersonalStandInSettings = {
      userId: 1,
      executionDeviceId: 'cloud-1',
      version: 5,
      roles: [],
      lifecycle: { status: 'stopped' },
    }
    let latest = makeAccount('cloud-1')
    const pending = { deviceId: 'cloud-1', requestId: 'pending', expectedVersion: 5 }
    if (mode === 'read')
      latest = {
        ...latest,
        stopIntents: [pending],
        stopIntentGenerations: { 'cloud-1': pending.requestId },
      }
    const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue(stopped)
    const conflict = Object.assign(new Error('Version changed'), { code: 'version_conflict' })
    const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>().mockImplementation(async () => {
      personalGet.mockResolvedValue({ ...stopped, version: 6, lifecycle: undefined })
      throw conflict
    })
    const updateStopIntent = vi.fn(
      async (deviceId, operation, requestId, _expected, expectedVersion) => {
        if (operation === 'mark')
          latest = {
            ...latest,
            stopIntents: [{ deviceId, requestId, expectedVersion }],
            stopIntentGenerations: { [deviceId]: requestId },
          }
        return latest
      }
    )
    const services = {
      standInApi: { personalGet, lifecycle, binding: makeBindingStore() },
      personalAssistantAccountApi: { get: async () => latest, updateStopIntent },
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
    } as unknown as WorkbenchServices
    const source = createStandInInstanceSource({
      services,
      api: services.standInApi,
      userId: 1,
      backendUrl: account.backendUrl,
      accountMode: true,
      accountNavigationOnly: true,
    })
    const unsubscribe = source.subscribe(
      { account: latest, active: true, connected: true, devices: [cloudDevice('cloud-1')] },
      () => {}
    )
    try {
      if (mode === 'retry') {
        await waitFor(() => expect(source.getSnapshot().binding?.status).toBe('stopped'))
        expect(await source.stop()).toBe(false)
      }
      await waitFor(() => expect(source.getSnapshot().binding?.status).toBe('stopping'))
      expect(source.getSnapshot().error?.cause).toBe(conflict)
      expect(lifecycle).toHaveBeenCalledExactlyOnceWith(1, 'cloud-1', 'stop', stopped.version)
      expect(latest.stopIntents).toHaveLength(1)
      expect(updateStopIntent.mock.calls.some(([, operation]) => operation === 'clear')).toBe(false)
    } finally {
      unsubscribe()
    }
  }
)

it('invalidates a denied destination and reconciles a newer device choice received during bind', async () => {
  let latest = makeAccount('cloud-1')
  const available = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]
  const profile = (deviceId: string): PersonalStandInSettings => ({
    userId: 1,
    executionDeviceId: deviceId,
    version: 1,
    roles: [],
  })
  const deny = new ApiError('Account access revoked', 403)
  const getAccount = vi.fn(async () => latest)
  const started = Promise.withResolvers<void>()
  const finishStart = Promise.withResolvers<PersonalStandInSettings>()
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  lifecycle.mockImplementation(async () => {
    started.resolve()
    return finishStart.promise
  })
  const services = {
    standInApi: {
      personalGet: async (_user: number, device: string) => profile(device),
      lifecycle,
      binding: makeBindingStore(),
    },
    personalAssistantAccountApi: {
      get: getAccount,
      updateDefinitions: async (
        _revision: string,
        definitions: Array<{ roleId: string; executionDeviceId?: string }>
      ) => {
        latest = makeAccount(
          definitions.find(d => d.roleId === '@primary')?.executionDeviceId,
          'bind-revision'
        )
        return latest
      },
    },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
  } as unknown as WorkbenchServices
  const source = createStandInInstanceSource({
    services,
    api: services.standInApi,
    userId: 1,
    backendUrl: account.backendUrl,
    accountMode: true,
    accountNavigationOnly: true,
  })
  const subscribe = () =>
    source.subscribe(
      {
        account: latest,
        readAccount: () => latest,
        publishAccount: next => {
          latest = next
        },
        active: true,
        connected: true,
        devices: available,
      },
      () => {}
    )
  let unsubscribe = subscribe()
  let binding: Promise<void> | undefined
  try {
    await waitFor(() => expect(source.getSnapshot().binding?.target?.deviceId).toBe('cloud-1'))
    getAccount.mockRejectedValueOnce(deny)
    await expect(source.bind({ ...account, deviceId: 'cloud-2' })).rejects.toBe(deny)
    expect(source.getSnapshot().binding).toBeUndefined()
    expect(source.getSnapshot().error?.cause).toBe(deny)
    expect(lifecycle).not.toHaveBeenCalled()
    source.reload()
    await waitFor(() => expect(source.getSnapshot().binding?.target?.deviceId).toBe('cloud-2'))
    binding = source.bind({ ...account, deviceId: 'cloud-1' })
    await started.promise
    // The peer's selection arrives after the start was dispatched but before it completes.
    latest = makeAccount('cloud-2', 'peer-revision')
    unsubscribe()
    unsubscribe = subscribe()
    finishStart.resolve(profile('cloud-1'))
    await binding
    await waitFor(() => expect(source.getSnapshot().binding?.target?.deviceId).toBe('cloud-2'))
    expect(source.getSnapshot().binding?.status).toBe('active')
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith(1, 'cloud-1', 'start', 1)
  } finally {
    finishStart.resolve(profile('cloud-1'))
    await binding
    unsubscribe()
  }
})

it('does not start a stopped destination after the owner leaves during marker reload', async () => {
  const available = [cloudDevice('cloud-1'), cloudDevice('cloud-2')]
  const profile: PersonalStandInSettings = {
    userId: 1,
    executionDeviceId: 'cloud-2',
    version: 2,
    roles: [],
    lifecycle: { status: 'stopped' },
  }
  const active: PersonalStandInSettings = {
    ...profile,
    executionDeviceId: 'cloud-1',
    lifecycle: undefined,
  }
  const pending = { deviceId: 'cloud-2', requestId: 'pending', expectedVersion: 1 }
  let latest: PersonalAssistantAccount = {
    ...makeAccount('cloud-1'),
    stopIntents: [pending],
    stopIntentGenerations: { 'cloud-2': pending.requestId },
  }
  const reloadStarted = Promise.withResolvers<void>()
  const reload = Promise.withResolvers<PersonalAssistantAccount>()
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>().mockResolvedValue(profile)
  const services = {
    standInApi: {
      personalGet: async (_user: number, device: string) =>
        device === 'cloud-2' ? profile : active,
      lifecycle,
      binding: makeBindingStore(),
    },
    personalAssistantAccountApi: {
      get: async () => {
        if (latest.stopIntents?.length === 0) {
          reloadStarted.resolve()
          return reload.promise
        }
        return latest
      },
      updateDefinitions: async () => {
        latest = {
          ...makeAccount('cloud-2'),
          stopIntents: [pending],
          stopIntentGenerations: { 'cloud-2': pending.requestId },
        }
        return latest
      },
      updateStopIntent: async () => {
        latest = { ...latest, stopIntents: [] }
        return latest
      },
    },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
  } as unknown as WorkbenchServices
  const source = createStandInInstanceSource({
    services,
    api: services.standInApi,
    userId: 1,
    backendUrl: account.backendUrl,
    accountMode: true,
    accountNavigationOnly: true,
  })
  const unsubscribe = source.subscribe(
    {
      account: latest,
      readAccount: () => latest,
      publishAccount: next => {
        latest = next
      },
      active: true,
      connected: true,
      devices: available,
    },
    () => {}
  )
  let binding: Promise<void> | undefined
  try {
    await waitFor(() => expect(source.getSnapshot().binding?.target?.deviceId).toBe('cloud-1'))
    binding = source.bind({ ...account, deviceId: 'cloud-2' })
    await reloadStarted.promise
    unsubscribe()
    await Promise.resolve()
    reload.resolve(latest)
    await expect(binding).rejects.toMatchObject({ name: 'AbortError' })
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith(1, 'cloud-2', 'stop', 2)
  } finally {
    reload.resolve(latest)
    await binding?.catch(() => {})
    unsubscribe()
  }
})

it('reselects a reachable setup target when the selected device goes offline', async () => {
  const personalGet = vi.fn<StandInExecutorApi['personalGet']>().mockResolvedValue({
    userId: 1,
    executionDeviceId: 'local',
    version: 0,
    roles: [],
  })
  const lifecycle = vi.fn<StandInExecutorApi['lifecycle']>()
  const services = {
    standInApi: { binding: makeBindingStore(), personalGet, lifecycle },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
  } as unknown as WorkbenchServices
  const { result, rerender } = renderHook(
    ({ available }) => useStandInInstance(services, 1, available, true, true, account.backendUrl),
    { initialProps: { available: [cloudDevice('cloud-1')] } }
  )
  await waitFor(() => expect(result.current.setupTarget?.deviceId).toBe('cloud-1'))
  rerender({ available: [cloudDevice('cloud-1', 'offline')] })
  await waitFor(() => expect(result.current.setupTarget?.deviceId).toBe('local'))
  expect(lifecycle).not.toHaveBeenCalled()
})
