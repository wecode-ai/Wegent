import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutorClient } from '@/api/executorAccess'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { initialWorkbenchState } from './workbenchReducer'
import type { WorkbenchServices } from './workbenchServices'
import { RuntimeTaskLifecycleStore, useRuntimeTaskSummaryResolver } from './runtimeTaskLifecycle'
import { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'

vi.mock('@/lib/navigation', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/navigation')>()),
  navigateTo: vi.fn((path: string) => window.history.replaceState({}, '', path)),
}))

const address: RuntimeTaskAddress = { deviceId: 'device-1', taskId: 'unlisted' }
const task: RuntimeTaskSummary = {
  taskId: 'unlisted',
  title: 'The original review',
  runtime: 'codex',
  threadId: 'thread-1',
  workspacePath: '/unlisted-workspace',
  modelSelection: { modelName: 'original-model', modelType: 'runtime', options: {} },
  runtimeHandle: { modelSelection: { modelName: 'original-model', modelType: 'runtime' } },
}

function setup(readTask = vi.fn().mockResolvedValue({ success: true, task })) {
  const lifecycleStore = new RuntimeTaskLifecycleStore('unlisted-open')
  const dispatch = vi.fn()
  const state = {
    ...initialWorkbenchState,
    runtimeWork: { projects: [], chats: [], totalTasks: 0 },
  }
  const modelStore = {
    models: [],
    selectedModelByScope: {},
    selectedModelOptionsByScope: {},
    hasSelectionForScope: () => false,
    setSelectionForScope: vi.fn(),
    setSelectedModelForScope: vi.fn(),
    setSelectedModelAndOptionsForScope: vi.fn(),
    setSelectedModelOptionForScope: vi.fn(),
  }
  const hook = renderHook(() => {
    const resolveTask = useRuntimeTaskSummaryResolver(state.runtimeWork, lifecycleStore)
    return {
      actions: useWorkbenchRuntimeTasks({
        ownershipKey: JSON.stringify(['', 7]),
        state,
        dispatch,
        executorClient: {} as ExecutorClient,
        services: { standInApi: { readTask } } as unknown as WorkbenchServices,
        lifecycleStore,
        markRuntimeTasksArchived: vi.fn(),
        refreshWorkLists: vi.fn(),
        setComposerErrorForScope: vi.fn(),
      }),
      resolveTask,
      modelSelection: useRuntimeTaskModelSelection({ userId: 7, resolveTask, modelStore }),
    }
  })
  return { ...hook, lifecycleStore, dispatch, readTask, state }
}

describe('opening an unlisted original task', () => {
  it('restores real task metadata and workspace without adding a sidebar task', async () => {
    const { result, readTask, dispatch, state, rerender } = setup()
    await act(() => result.current.actions.openRuntimeTask(address))
    expect(readTask).toHaveBeenCalledWith('device-1', 'unlisted')
    expect(result.current.resolveTask(address)).toMatchObject(task)
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'runtime_task_opened',
      address: expect.objectContaining({
        ...address,
        runtime: 'codex',
        threadId: 'thread-1',
        workspacePath: '/unlisted-workspace',
        runtimeHandle: task.runtimeHandle,
      }),
      project: null,
    })
    expect(dispatch.mock.calls.every(([action]) => action.type === 'runtime_task_opened')).toBe(
      true
    )
    state.runtimeWork = { projects: [], chats: [], totalTasks: 0 }
    rerender()
    expect(result.current.resolveTask(address)?.modelSelection).toEqual(task.modelSelection)
    expect(
      result.current.modelSelection.resolveRuntimeTaskModelSelection(address).selectedModel
    ).toMatchObject({ name: 'original-model', type: 'runtime' })
    expect(state.runtimeWork.totalTasks).toBe(0)
  })

  it('rejects a response for another task instead of attaching its metadata', async () => {
    const { result, lifecycleStore, dispatch } = setup(
      vi.fn().mockResolvedValue({ success: true, task: { ...task, taskId: 'another-task' } })
    )
    await act(() => result.current.actions.openRuntimeTask(address))
    expect(lifecycleStore.getTask(address)).toBeNull()
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'error_set', error: expect.any(String) })
  })

  it('preserves an explicitly bound workspace and Issue authority while restoring metadata', async () => {
    const { result, dispatch } = setup()
    const bound = {
      ...address,
      workspacePath: task.workspacePath,
      projectSession: { projectId: 'project-1', issueId: 'issue-1' },
      issueExecution: { projectId: 'project-1', issueId: 'issue-1' },
    }
    await act(() => result.current.actions.openRuntimeTask(bound))
    expect(result.current.resolveTask(address)?.title).toBe(task.title)
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'runtime_task_opened',
        address: expect.objectContaining(bound),
      })
    )
  })

  it('does not apply an old read after the user has opened a different task', async () => {
    let finishFirst!: (value: unknown) => void
    const readTask = vi.fn().mockImplementation((_deviceId, taskId) =>
      taskId === 'unlisted'
        ? new Promise(resolve => {
            finishFirst = resolve
          })
        : Promise.resolve({ success: true, task: { ...task, taskId } })
    )
    const { result, lifecycleStore, dispatch } = setup(readTask)
    let first!: Promise<void>
    act(() => {
      first = result.current.actions.openRuntimeTask(address)
    })
    await act(() => result.current.actions.openRuntimeTask({ ...address, taskId: 'new-task' }))
    await act(async () => {
      finishFirst({ success: true, task })
      await first
    })
    expect(lifecycleStore.getTask(address)).toBeNull()
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'runtime_task_opened',
        address: expect.objectContaining({ taskId: 'new-task' }),
      })
    )
  })

  it('does not update a disposed account or workbench after its read completes', async () => {
    let finish!: (value: unknown) => void
    const { result, lifecycleStore, dispatch, unmount } = setup(
      vi.fn().mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        })
      )
    )
    let opening!: Promise<void>
    act(() => {
      opening = result.current.actions.openRuntimeTask(address)
    })
    unmount()
    const calls = dispatch.mock.calls.length
    await act(async () => {
      finish({ success: true, task })
      await opening
    })
    expect(dispatch).toHaveBeenCalledTimes(calls)
    expect(lifecycleStore.getTask(address)).toBeNull()
  })

  it('does not reopen an old task after the user has selected a project or new chat', async () => {
    let finish!: (value: unknown) => void
    const { result, state, dispatch, lifecycleStore, rerender } = setup(
      vi.fn().mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        })
      )
    )
    let opening!: Promise<void>
    act(() => {
      opening = result.current.actions.openRuntimeTask(address)
    })
    state.currentRuntimeTask = address
    rerender()
    state.currentRuntimeTask = null
    rerender()
    const calls = dispatch.mock.calls.length
    await act(async () => {
      finish({ success: true, task })
      await opening
    })
    expect(dispatch).toHaveBeenCalledTimes(calls)
    expect(lifecycleStore.getTask(address)).toBeNull()
  })

  it('does not navigate back after the user has opened an auxiliary page', async () => {
    let finish!: (value: unknown) => void
    const { result, dispatch, lifecycleStore } = setup(
      vi.fn().mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        })
      )
    )
    let opening!: Promise<void>
    act(() => {
      opening = result.current.actions.openRuntimeTask(address)
    })
    window.history.replaceState({}, '', '/settings/archived-conversations')
    const calls = dispatch.mock.calls.length
    await act(async () => {
      finish({ success: true, task })
      await opening
    })
    expect(dispatch).toHaveBeenCalledTimes(calls)
    expect(lifecycleStore.getTask(address)).toBeNull()
  })
})
