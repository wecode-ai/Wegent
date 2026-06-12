import { describe, expect, test } from 'vitest'
import type { DeviceInfo, ProjectWithTasks, Task } from '@/types/api'
import {
  findProjectForTask,
  findWorkbenchDevice,
  isWorkbenchDeviceOnline,
} from './workbench-device'

describe('workbench-device', () => {
  test('treats a missing configured device as unavailable', () => {
    const devices: DeviceInfo[] = []
    const device = findWorkbenchDevice(devices, 'missing-device')

    expect(device).toBeNull()
    expect(isWorkbenchDeviceOnline(device)).toBe(false)
  })

  test('finds a task owning project from nested project task records', () => {
    const projects: ProjectWithTasks[] = [
      {
        id: 7,
        name: 'Wegent',
        tasks: [{ id: 71, task_id: 71, task_title: 'Continue project work' }],
      },
    ]
    const task: Task = {
      id: 71,
      title: 'Continue project work',
      status: 'SUCCESS',
      task_type: 'code',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    expect(findProjectForTask(projects, task)?.id).toBe(7)
  })
})
