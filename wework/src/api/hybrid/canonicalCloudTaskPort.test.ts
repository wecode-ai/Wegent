import { expect, it, vi } from 'vitest'
import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'
import { canonicalCloudTaskPort } from './canonicalCloudTaskPort'

it('uses the Runtime-attested cloud registration consistently without caching an old installation', async () => {
  const port = {
    bindTask: vi.fn(),
    unbindTask: vi.fn(),
    findIssueForTask: vi.fn(),
    findCloudContextForTask: vi.fn(),
    unbindCloudContext: vi.fn(),
    trackProjectTask: vi.fn(),
    reportExecutionLifecycle: vi.fn(),
  }
  const identity = vi.fn().mockResolvedValue({ backendDeviceId: 'app-record-42' })
  const api = canonicalCloudTaskPort(port as WeworkWorkspaceRuntimePort, identity)
  const task = {
    deviceId: 'shared-desktop-alias',
    taskId: 'private-task',
    workspacePath: '/workspace',
  }
  const dispatch = {
    humanAssignmentId: 'human',
    dispatchId: 'dispatch',
    dispatchRoundId: 'round',
    assignmentId: 'assignment',
  }
  await api.bindTask('issue', task, 'Title', dispatch)
  await api.findIssueForTask(task)
  await api.findCloudContextForTask(task)
  await api.trackProjectTask('project', task, 'Title', 'Description')
  await api.unbindCloudContext(task)
  expect(port.bindTask).toHaveBeenCalledExactlyOnceWith(
    'issue',
    { ...task, deviceId: 'app-record-42' },
    'Title',
    dispatch
  )
  expect(port.findIssueForTask).toHaveBeenCalledExactlyOnceWith({
    ...task,
    deviceId: 'app-record-42',
  })
  expect(port.findCloudContextForTask).toHaveBeenCalledExactlyOnceWith({
    ...task,
    deviceId: 'app-record-42',
  })
  expect(port.trackProjectTask).toHaveBeenCalledExactlyOnceWith(
    'project',
    { ...task, deviceId: 'app-record-42' },
    'Title',
    'Description'
  )
  expect(port.unbindCloudContext).toHaveBeenCalledExactlyOnceWith({
    ...task,
    deviceId: 'app-record-42',
  })
  identity.mockResolvedValue({ backendDeviceId: 'app-record-71' })
  await api.unbindTask('issue', task)
  expect(port.unbindTask).toHaveBeenCalledExactlyOnceWith('issue', {
    ...task,
    deviceId: 'app-record-71',
  })
  expect(api.reportExecutionLifecycle).toBe(port.reportExecutionLifecycle)
  expect(task.deviceId).toBe('shared-desktop-alias')
})

it('refuses to bind through an ambiguous alias when the Runtime has no registered identity', async () => {
  const bindTask = vi.fn()
  const api = canonicalCloudTaskPort(
    { bindTask } as unknown as WeworkWorkspaceRuntimePort,
    vi.fn().mockResolvedValue({ backendDeviceId: '' })
  )
  await expect(api.bindTask('issue', { deviceId: 'alias', taskId: 'task' })).rejects.toThrow(
    'registered cloud device identity'
  )
  expect(bindTask).not.toHaveBeenCalled()
})
