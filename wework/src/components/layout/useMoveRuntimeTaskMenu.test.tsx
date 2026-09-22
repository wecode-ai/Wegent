import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { RuntimeDeviceWorkspace, RuntimeProjectWork, RuntimeTaskSummary } from '@/types/api'
import { useMoveRuntimeTaskMenu } from './useMoveRuntimeTaskMenu'

const task = { taskId: 'task-1', threadId: 'thread-1', runtime: 'codex' } as RuntimeTaskSummary
const workspace: RuntimeDeviceWorkspace = {
  deviceId: 'local',
  available: true,
  workspacePath: '/source',
  tasks: [task],
}
function project(key: string, overrides: Partial<RuntimeDeviceWorkspace> = {}): RuntimeProjectWork {
  return {
    project: { key, name: key, stateDeviceId: 'local' },
    deviceWorkspaces: [{ ...workspace, workspacePath: `/${key}`, tasks: [], ...overrides }],
  }
}
function setup(
  projects: RuntimeProjectWork[],
  source = workspace,
  threadId: string | null = 'thread-1',
  summary = task
) {
  const reorderRuntimeProjectTasks = vi.fn().mockResolvedValue(undefined)
  const setWorkbenchError = vi.fn()
  const value = {
    state: { runtimeWork: { projects, chats: [], totalTasks: 1 } },
    reorderRuntimeProjectTasks,
    setWorkbenchError,
  } as unknown as WorkbenchContextValue
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
  )
  return {
    ...renderHook(() => useMoveRuntimeTaskMenu(source, summary, threadId), { wrapper }),
    reorderRuntimeProjectTasks,
    setWorkbenchError,
  }
}

describe('move runtime task menu', () => {
  test('offers only other available projects on the same device and host', async () => {
    const { result, reorderRuntimeProjectTasks } = setup([
      project('source', { tasks: [task] }),
      project('target'),
      project('offline', { available: false }),
      project('other-device', { deviceId: 'other' }),
      project('remote', { remoteHostId: 'ssh-host' }),
      {
        ...project('other-owner'),
        project: { key: 'other-owner', name: 'Other', stateDeviceId: 'other' },
      },
      { ...project('cloud'), project: { key: 'cloud', name: 'Cloud' } },
    ])
    expect(result.current.children?.map(item => item.label)).toEqual(['target'])
    await act(async () => {
      await result.current.children?.[0].onSelect?.()
    })
    expect(reorderRuntimeProjectTasks).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'local',
      projectKey: 'target',
      threadId: 'thread-1',
      insertAtEnd: true,
    })
  })

  test('blocks duplicate moves and allows retry after a failed request', async () => {
    const { result, reorderRuntimeProjectTasks, setWorkbenchError } = setup([project('target')])
    let reject!: (error: Error) => void
    reorderRuntimeProjectTasks.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    let pending: void | Promise<void>
    act(() => {
      pending = result.current.children?.[0].onSelect?.()
    })
    expect(result.current.disabled).toBe(true)
    await act(async () => {
      await result.current.children?.[0].onSelect?.()
    })
    expect(reorderRuntimeProjectTasks).toHaveBeenCalledTimes(1)
    await act(async () => {
      reject(new Error('offline'))
      await pending
    })
    expect(setWorkbenchError).toHaveBeenCalledWith('移动任务失败，请重试。')
    expect(result.current.disabled).toBe(false)
    await act(async () => {
      await result.current.children?.[0].onSelect?.()
    })
    expect(reorderRuntimeProjectTasks).toHaveBeenCalledTimes(2)
  })

  test('disables moving without a destination, session, or available source', () => {
    expect(setup([]).result.current.disabled).toBe(true)
    expect(setup([project('target')], workspace, null).result.current.disabled).toBe(true)
    expect(
      setup([project('target')], workspace, task.taskId, { ...task, threadId: undefined }).result
        .current.disabled
    ).toBe(true)
    expect(
      setup([project('target')], { ...workspace, available: false }).result.current.disabled
    ).toBe(true)
  })
})
