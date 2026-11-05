import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { LOCAL_USER } from '@/api/local/localSession'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { RuntimeWorkListResponse } from '@/types/api'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import {
  RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStore,
  useRuntimeTaskSummaryResolver,
} from './runtimeTaskLifecycle'
import { useWorkbench } from './useWorkbench'

const ADDRESS = { deviceId: 'same-device', taskId: 'same-task', workspacePath: '/workspace' }
const EMPTY_WORK: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
const OWNER_A_WORK: RuntimeWorkListResponse = {
  projects: [],
  chats: [
    {
      deviceId: ADDRESS.deviceId,
      workspacePath: ADDRESS.workspacePath,
      workspaceKind: 'chat',
      tasks: [
        {
          taskId: ADDRESS.taskId,
          workspacePath: ADDRESS.workspacePath,
          title: 'Owner A private task',
          runtime: 'codex',
          threadId: 'owner-a-thread',
          modelSelection: { modelName: 'owner-a-model', modelType: 'runtime' },
        },
      ],
    },
  ],
  totalTasks: 1,
}

function connection(
  userId: number,
  apiBaseUrl: string,
  token = 'initial'
): CloudConnectionContextValue {
  return {
    ...DISCONNECTED_STATE,
    user: { id: userId, user_name: `owner-${userId}`, email: `${userId}@example.com` },
    apiBaseUrl,
    token,
    isConnected: true,
    serviceKey: `${apiBaseUrl}:${userId}:${token}`,
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }
}

function services(work: RuntimeWorkListResponse): WorkbenchServices {
  return {
    teamApi: { listTeams: vi.fn().mockResolvedValue([]) },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: { listProjects: vi.fn().mockResolvedValue({ items: [] }) },
    taskApi: {},
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: ADDRESS.deviceId,
          name: 'Local',
          status: 'online',
          device_type: 'local',
          is_default: true,
        },
      ]),
      listSkills: vi.fn().mockResolvedValue([]),
    },
    runtimeWorkApi: { listRuntimeWork: vi.fn().mockResolvedValue(work) },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
  } as unknown as WorkbenchServices
}

function setup() {
  const firstServices = services(OWNER_A_WORK)
  const nextServices = services(EMPTY_WORK)
  let currentStore: RuntimeTaskLifecycleStore | undefined
  function Probe() {
    const { state } = useWorkbench()
    currentStore = useRuntimeTaskLifecycleStore()
    const resolveTask = useRuntimeTaskSummaryResolver(state.runtimeWork)
    return (
      <>
        <output data-testid="owner-ready">{`${state.user?.id}:${state.runtimeWorkLoad.phase}:${state.runtimeWork?.totalTasks}`}</output>
        <output data-testid="owner-summary">{resolveTask(ADDRESS)?.title ?? 'none'}</output>
      </>
    )
  }
  const tree = (
    cloud: CloudConnectionContextValue,
    workbenchServices: WorkbenchServices,
    store?: RuntimeTaskLifecycleStore
  ) => (
    <CloudConnectionContext.Provider value={cloud}>
      <WorkbenchProvider
        user={LOCAL_USER}
        services={workbenchServices}
        lifecycleStore={store}
        loadTaskComposerCatalogs={false}
        syncRemoteProjects={false}
        debugSnapshotEnabled={false}
        publishDebugSnapshots={false}
      >
        <Probe />
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
  return { firstServices, nextServices, tree, store: () => currentStore! }
}

describe('workbench lifecycle ownership', () => {
  test('rebuilds the local workbench when cloud credentials expire with reconnect metadata retained', async () => {
    const fixture = setup()
    const active = connection(7, 'https://backend-a.example/api')
    const view = render(fixture.tree(active, fixture.firstServices))
    await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:1'))
    expect(screen.getByTestId('owner-summary')).toHaveTextContent('Owner A private task')

    view.rerender(
      fixture.tree(
        { ...active, status: 'expired', isConnected: false, token: null, serviceKey: 'expired' },
        fixture.nextServices
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('owner-ready')).toHaveTextContent(`${LOCAL_USER.id}:ready:0`)
    )
    expect(screen.getByTestId('owner-summary')).toHaveTextContent(/^none$/)
  })

  test.each([
    ['account', 8, 'https://backend-a.example/api'],
    ['backend', 7, 'https://backend-b.example/api'],
  ] as const)(
    'does not resolve a previous %s owner task from the fallback store',
    async (_kind, nextUser, nextBackend) => {
      const fixture = setup()
      const view = render(
        fixture.tree(connection(7, 'https://backend-a.example/api'), fixture.firstServices)
      )
      await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:1'))
      expect(screen.getByTestId('owner-summary')).toHaveTextContent('Owner A private task')

      view.rerender(fixture.tree(connection(nextUser, nextBackend), fixture.nextServices))
      await waitFor(() =>
        expect(screen.getByTestId('owner-ready')).toHaveTextContent(`${nextUser}:ready:0`)
      )
      expect(screen.getByTestId('owner-summary')).toHaveTextContent(/^none$/)
    }
  )

  test('does not seed a new owner shared store from the old reducer snapshot', async () => {
    const fixture = setup()
    const previousStore = new RuntimeTaskLifecycleStore('backend-a:7')
    const nextStore = new RuntimeTaskLifecycleStore('backend-b:7')
    const view = render(
      fixture.tree(
        connection(7, 'https://backend-a.example/api'),
        fixture.firstServices,
        previousStore
      )
    )
    await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:1'))
    expect(previousStore.getTask(ADDRESS)?.task?.threadId).toBe('owner-a-thread')

    view.rerender(
      fixture.tree(connection(7, 'https://backend-b.example/api'), fixture.nextServices, nextStore)
    )
    await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:0'))
    expect(nextStore.getTask(ADDRESS)).toBeNull()
    expect(screen.getByTestId('owner-summary')).toHaveTextContent(/^none$/)
  })

  test('retains an unlisted task in the same owner store across token replacement', async () => {
    const fixture = setup()
    const sharedStore = new RuntimeTaskLifecycleStore('backend-a:7')
    const view = render(
      fixture.tree(
        connection(7, 'https://backend-a.example/api'),
        fixture.firstServices,
        sharedStore
      )
    )
    await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:1'))
    const previousStore = fixture.store()

    view.rerender(
      fixture.tree(
        connection(7, 'https://backend-a.example/api', 'refreshed'),
        fixture.nextServices,
        sharedStore
      )
    )
    await waitFor(() => expect(screen.getByTestId('owner-ready')).toHaveTextContent('7:ready:0'))
    expect(fixture.store()).toBe(previousStore)
    expect(screen.getByTestId('owner-summary')).toHaveTextContent('Owner A private task')
    expect(sharedStore.getTask(ADDRESS)?.task?.modelSelection?.modelName).toBe('owner-a-model')
  })
})
