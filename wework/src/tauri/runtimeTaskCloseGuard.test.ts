import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  CLOSE_TO_TRAY_HINT_REQUESTED_EVENT,
  closeMainWindowToTray,
  hasRunningRuntimeTasks,
  installRuntimeTaskCloseGuard,
  shouldPreventRuntimeTaskClose,
} from './runtimeTaskCloseGuard'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

function runtimeWorkWithTasks(tasks: Array<{ running?: boolean }>): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 1, key: 'project-1', name: 'Project 1' },
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace',
            tasks: tasks.map((task, index) => ({
              taskId: `task-${index}`,
              workspacePath: '/workspace',
              title: `Task ${index}`,
              runtime: 'codex',
              ...task,
            })),
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

describe('runtime task close guard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  test('detects running tasks across runtime work', () => {
    expect(hasRunningRuntimeTasks(runtimeWorkWithTasks([{ running: false }]))).toBe(false)
    expect(hasRunningRuntimeTasks(runtimeWorkWithTasks([{ running: true }]))).toBe(true)
    expect(
      hasRunningRuntimeTasks({
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/chat',
            tasks: [
              {
                taskId: 'chat-task',
                workspacePath: '/chat',
                title: 'Chat task',
                runtime: 'claude_code',
                running: true,
              },
            ],
          },
        ],
        totalTasks: 1,
      })
    ).toBe(true)
  })

  test('does not prompt when no runtime task is running', () => {
    const confirmClose = vi.fn()

    expect(shouldPreventRuntimeTaskClose(runtimeWorkWithTasks([]), confirmClose)).toBe(false)
    expect(confirmClose).not.toHaveBeenCalled()
  })

  test('prevents close when running tasks exist and the user cancels', () => {
    const confirmClose = vi.fn().mockReturnValue(false)

    expect(
      shouldPreventRuntimeTaskClose(runtimeWorkWithTasks([{ running: true }]), confirmClose)
    ).toBe(true)
    expect(confirmClose).toHaveBeenCalledTimes(1)
  })

  test('does not prevent close decision when running tasks exist and the user confirms', () => {
    const confirmClose = vi.fn().mockReturnValue(true)

    expect(
      shouldPreventRuntimeTaskClose(runtimeWorkWithTasks([{ running: true }]), confirmClose)
    ).toBe(false)
    expect(confirmClose).toHaveBeenCalledTimes(1)
  })

  test('listens for the close-to-tray hint request event', async () => {
    const unlisten = vi.fn()
    const onCloseToTrayHintRequest = vi.fn()
    listenMock.mockResolvedValue(unlisten)

    const result = await installRuntimeTaskCloseGuard(onCloseToTrayHintRequest)

    expect(listenMock).toHaveBeenCalledWith(
      CLOSE_TO_TRAY_HINT_REQUESTED_EVENT,
      expect.any(Function)
    )

    const callback = listenMock.mock.calls[0][1] as () => void
    callback()

    expect(onCloseToTrayHintRequest).toHaveBeenCalledTimes(1)
    expect(result).toBe(unlisten)
  })

  test('closes the main window to tray through the Tauri command', async () => {
    invokeMock.mockResolvedValue(undefined)

    await closeMainWindowToTray()

    expect(invokeMock).toHaveBeenCalledWith('close_main_window_to_tray')
  })
})
