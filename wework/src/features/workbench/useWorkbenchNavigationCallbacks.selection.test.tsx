import type { ExecutorClient } from '@/api/executorAccess'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectWithTasks, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { navigateTo } from '@/lib/navigation'
import { resolveRuntimeTaskProjects } from '@/lib/runtime-project'
import { initialWorkbenchState, workbenchReducer, type WorkbenchAction } from './workbenchReducer'
import {
  useOpenStandaloneWorkspace,
  useSelectProject,
  useSelectProjectWorkspace,
  useSelectStandaloneDevice,
} from './useWorkbenchNavigationCallbacks'

vi.mock('@/lib/navigation', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/navigation')>()),
  navigateTo: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const project = { id: 7, name: 'Code', tasks: [] } as unknown as ProjectWithTasks
const state = {
  projects: [project],
  devices: [],
  runtimeWork: null,
  standaloneDeviceId: null,
} as unknown as WorkbenchState

it.each([
  ['select', 'project_selected'],
  ['clear', 'project_cleared'],
  ['workspace', 'project_workspace_selected'],
  ['device', 'project_cleared'],
])(
  'keeps the %s transaction while allowing the caller to retain its route',
  (operation, action) => {
    for (const stay of [false, true]) {
      const dispatch = vi.fn()
      const projectSelectionStartedRef = { current: false }
      const props = {
        state,
        dispatch,
        projectSelectionStartedRef,
        ownershipKey: 'selection-review',
        user: { id: 7 } as User,
      }
      const { result, unmount } = renderHook(() => ({
        project: useSelectProject(props),
        workspace: useSelectProjectWorkspace(props),
        device: useSelectStandaloneDevice(props),
      }))
      vi.mocked(navigateTo).mockClear()
      const options = stay ? { navigate: false } : undefined
      act(() => {
        if (operation === 'workspace') result.current.workspace(7, 21, options)
        else if (operation === 'device') result.current.device(null, options)
        else result.current.project(operation === 'clear' ? null : 7, options)
      })
      expect(projectSelectionStartedRef.current).toBe(true)
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: action }))
      if (stay) expect(navigateTo).not.toHaveBeenCalled()
      else expect(navigateTo).toHaveBeenCalledExactlyOnceWith('/')
      unmount()
    }
  }
)

it('confirms a registered local project while unrelated task-list refresh is pending', async () => {
  let release!: () => void
  const refresh = new Promise<void>(resolve => {
    release = resolve
  })
  let localState = {
    ...initialWorkbenchState,
    devices: [{ device_id: 'device' }],
  } as WorkbenchState
  const dispatch = (action: WorkbenchAction) => {
    localState = workbenchReducer(localState, action)
  }
  const client = {
    runtime: {
      upsertLocalRuntimeProject: async () => ({
        accepted: true,
        deviceId: 'device',
        projectKey: 'registered',
        name: 'Created',
        roots: ['/workspace'],
      }),
    },
  } as unknown as ExecutorClient
  const { result } = renderHook(() =>
    useOpenStandaloneWorkspace({
      state: localState,
      getSnapshot: () => ({ state: localState }),
      projectSelectionStartedRef: { current: false },
      executorClient: client,
      dispatch,
      clearRemoteProjectSyncRemoval: vi.fn(),
      ownershipKey: 'create-nonblocking',
      refreshWorkLists: () => refresh,
    })
  )
  let confirmed = false
  try {
    act(() => {
      void result.current('device', '/workspace', 'Created', ['/workspace']).then(() => {
        confirmed = true
      })
    })
    await waitFor(() => expect(confirmed).toBe(true))
    expect(localState.currentProject?.name).toBe('Created')
    expect(resolveRuntimeTaskProjects(localState.projects, localState.runtimeWork)).toEqual([
      expect.objectContaining({ id: localState.currentProject?.id, name: 'Created' }),
    ])
    expect(localState.runtimeWork?.projects[0].project.roots).toEqual([
      { kind: 'local', path: '/workspace' },
    ])
    expect(localState.runtimeWork?.projects[0].deviceWorkspaces[0].workspacePath).toBe('/workspace')
    expect(navigateTo).toHaveBeenCalledWith('/')
  } finally {
    await act(async () => {
      release()
    })
  }
})
