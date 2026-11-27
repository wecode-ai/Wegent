import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { isPopoutWindowRuntime } from '@/appWindowIdentity'
import type { ProjectWithTasks, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { navigateTo } from '@/lib/navigation'
import {
  useSelectProject,
  useSelectProjectWorkspace,
  useSelectStandaloneDevice,
  useStartNewChat,
} from './useWorkbenchNavigationCallbacks'

vi.mock('@/appWindowIdentity', () => ({ isPopoutWindowRuntime: vi.fn() }))
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

it('starts a blank chat without leaving the popout route', () => {
  vi.mocked(isPopoutWindowRuntime).mockReturnValueOnce(true)
  const dispatch = vi.fn()
  const { result } = renderHook(() =>
    useStartNewChat({
      canNavigateWorkspaceTab: () => true,
      state,
      dispatch,
      ownershipKey: 'popout-navigation-review',
      workspaceTabId: undefined,
      user: { id: 7 } as User,
      setDraftInputForScope: vi.fn(),
    })
  )
  act(result.current)
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'project_cleared' }))
  expect(navigateTo).not.toHaveBeenCalled()
})

it('seeds a separate draft when starting a new chat with initial input', () => {
  const dispatch = vi.fn()
  const setDraftInputForScope = vi.fn()
  const { result } = renderHook(() =>
    useStartNewChat({
      canNavigateWorkspaceTab: () => true,
      state: { ...state, standaloneChatKey: 4 },
      dispatch,
      ownershipKey: 'recovery-navigation-review',
      workspaceTabId: undefined,
      user: { id: 7 } as User,
      setDraftInputForScope,
    })
  )

  act(() => result.current({ initialInput: 'original conversation reference' }))

  expect(setDraftInputForScope).toHaveBeenCalledExactlyOnceWith(
    'blank:5',
    'original conversation reference'
  )
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: 'project_cleared', startFreshChat: true })
  )
})

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
