import { describe, expect, test, vi } from 'vitest'
import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'

import { createCloudProjectTaskRuntimeApi, rememberProjectTaskStore } from './projectTaskTracking'

describe('project task runtime binding', () => {
  test('preserves the assigned Team through the cloud runtime binding port', async () => {
    const bindTask = vi.fn().mockResolvedValue(undefined)
    const api = createCloudProjectTaskRuntimeApi({
      bindTask,
    } as unknown as WeworkWorkspaceRuntimePort)
    await api.bindTask(
      'ISSUE-1',
      {
        deviceId: 'local-device',
        taskId: 'runtime-team',
        runtimeHandle: { wegentTeam: { id: 1880 } },
      },
      'Team task'
    )
    expect(bindTask).toHaveBeenCalledWith(
      'ISSUE-1',
      {
        deviceId: 'local-device',
        taskId: 'runtime-team',
        wegentTeamId: 1880,
      },
      'Team task'
    )
  })
  test('maps the runtime model identity into the shared task binding and tracking contract', async () => {
    const bindTask = vi.fn().mockResolvedValue(undefined)
    const trackProjectTask = vi.fn().mockResolvedValue({ issue: {} })
    const port = { bindTask, trackProjectTask } as unknown as WeworkWorkspaceRuntimePort
    const api = createCloudProjectTaskRuntimeApi(port)
    const modelSelection = {
      modelName: 'deepseek-v4-pro-responses',
      modelType: 'public' as const,
      options: { reasoning: 'high' },
    }
    const task = {
      deviceId: 'remote-device',
      taskId: 'runtime-model-task',
      runtimeHandle: { modelSelection },
    }
    const sharedTask = {
      deviceId: task.deviceId,
      taskId: task.taskId,
      modelSelection,
    }

    await api.bindTask('ISSUE-1', task, 'Task')
    await api.trackProjectTask('project-1', task, 'Task', 'Description')

    expect(bindTask).toHaveBeenCalledWith('ISSUE-1', sharedTask, 'Task')
    expect(trackProjectTask).toHaveBeenCalledWith('project-1', sharedTask, 'Task', 'Description')
  })

  test('records project store changes only once per binding', () => {
    const address = { deviceId: 'local-device', taskId: 'runtime-bound-locally' }
    expect(rememberProjectTaskStore(address, 'local')).toBe(true)
    expect(rememberProjectTaskStore(address, 'local')).toBe(false)
    expect(rememberProjectTaskStore(address, 'backend')).toBe(true)
  })
})
