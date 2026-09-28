import { describe, expect, test } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { resolveRuntimeWorkbenchPane } from '@/components/layout/workbenchPaneIdentity'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

const address = { deviceId: 'local-device', taskId: 'task-1', workspacePath: '/repo' }
const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { key: 'local-project:repo', name: 'Repo', source: 'local_project' },
      totalTasks: 31,
      deviceWorkspaces: [
        {
          deviceId: address.deviceId,
          available: true,
          workspacePath: '/repo',
          tasks: [
            { taskId: address.taskId, title: 'Task', workspacePath: '/repo', runtime: 'codex' },
          ],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 31,
}

describe('project task restoration', () => {
  test.each(['bootstrapped', 'lists_refreshed', 'runtime_work_refreshed'] as const)(
    '%s recovers ownership when the task was restored before its project list',
    type => {
      const restored = workbenchReducer(initialWorkbenchState, {
        type: 'runtime_task_opened',
        address,
        project: null,
      })
      expect(restored.currentProject).toBeNull()

      const hydrated =
        type === 'bootstrapped'
          ? workbenchReducer(restored, {
              type,
              runtimeWork,
              projects: [],
              devices: [],
              user: { id: 1, user_name: 'test', email: 'test@example.com' },
            })
          : type === 'lists_refreshed'
            ? workbenchReducer(restored, {
                type,
                runtimeWork,
                projects: [],
                devices: [],
              })
            : workbenchReducer(restored, { type, runtimeWork })

      expect(hydrated.currentRuntimeTask).toEqual(address)
      expect(hydrated.currentProject).toMatchObject({
        id: runtimeProjectUiId(runtimeWork.projects[0].project),
        name: 'Repo',
      })
      expect(hydrated.runtimeWork?.projects[0].totalTasks).toBe(31)
    }
  )

  test('recovers ownership after startup reconciles an obsolete local device identity', () => {
    const hydrated = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentRuntimeTask: { ...address, deviceId: 'previous-local-device' },
      },
      { type: 'runtime_work_refreshed', runtimeWork }
    )

    expect(hydrated.currentRuntimeTask?.deviceId).toBe(address.deviceId)
    expect(hydrated.currentProject?.name).toBe('Repo')
  })

  test('does not infer project ownership for a standalone task sharing the same directory', () => {
    const standalone = { ...address, taskId: 'standalone-task' }
    const hydrated = workbenchReducer(
      { ...initialWorkbenchState, currentRuntimeTask: standalone },
      { type: 'runtime_work_refreshed', runtimeWork }
    )

    expect(hydrated.currentProject).toBeNull()
    expect(hydrated.currentRuntimeTask).toEqual(standalone)
  })

  test('does not confuse matching task IDs from different devices', () => {
    const hydrated = workbenchReducer(
      {
        ...initialWorkbenchState,
        currentRuntimeTask: { ...address, deviceId: 'remote-device' },
      },
      {
        type: 'lists_refreshed',
        projects: [],
        devices: [
          {
            id: 1,
            device_id: 'remote-device',
            name: 'Remote',
            status: 'online',
            device_type: 'remote',
            is_default: false,
            bind_shell: 'claudecode',
          },
        ],
        runtimeWork,
      }
    )

    expect(hydrated.currentProject).toBeNull()
  })

  test('restores project ownership for a saved split pane', () => {
    const pane = resolveRuntimeWorkbenchPane(runtimeWork, 'runtime:local-device:task-1')
    expect(pane?.currentRuntimeTask).toMatchObject(address)
    expect(pane?.currentProject?.name).toBe('Repo')
  })
})
