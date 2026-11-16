import { expect, it, vi } from 'vitest'
import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'
import { canonicalCloudTaskPort } from './canonicalCloudTaskPort'

const unknownDevice = async () => null

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
  const api = canonicalCloudTaskPort(port as WeworkWorkspaceRuntimePort, identity, unknownDevice)
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
    vi.fn().mockResolvedValue({ backendDeviceId: '' }),
    unknownDevice
  )
  await expect(api.bindTask('issue', { deviceId: 'alias', taskId: 'task' })).rejects.toThrow(
    'registered cloud device identity'
  )
  expect(bindTask).not.toHaveBeenCalled()
})

it('reads and removes an existing canonical binding without requiring an online Runtime', async () => {
  const port = {
    findIssueForTask: vi.fn(),
    findCloudContextForTask: vi.fn(),
    unbindTask: vi.fn(),
    unbindCloudContext: vi.fn(),
  }
  const identity = vi.fn().mockRejectedValue(new Error('Runtime offline'))
  const api = canonicalCloudTaskPort(
    port as unknown as WeworkWorkspaceRuntimePort,
    identity,
    unknownDevice
  )
  const task = { deviceId: 'app-record-42', taskId: 'existing' }
  await api.findIssueForTask(task)
  await api.findCloudContextForTask(task)
  await api.unbindTask('issue', task)
  await api.unbindCloudContext(task)
  expect(identity).not.toHaveBeenCalled()
  expect(port.findIssueForTask).toHaveBeenCalledExactlyOnceWith(task)
  expect(port.findCloudContextForTask).toHaveBeenCalledExactlyOnceWith(task)
  expect(port.unbindTask).toHaveBeenCalledExactlyOnceWith('issue', task)
  expect(port.unbindCloudContext).toHaveBeenCalledExactlyOnceWith(task)
})

it.each(['alias', 'app-record-0', 'app-record-42-other'])(
  'requires attestation for non-record metadata address %s',
  async deviceId => {
    const findIssueForTask = vi.fn()
    const api = canonicalCloudTaskPort(
      { findIssueForTask } as unknown as WeworkWorkspaceRuntimePort,
      vi.fn().mockRejectedValue(new Error('Runtime offline')),
      unknownDevice
    )
    await expect(api.findIssueForTask({ deviceId, taskId: 'task' })).rejects.toThrow(
      'Runtime offline'
    )
    expect(findIssueForTask).not.toHaveBeenCalled()
  }
)

it('requires live attestation for a new binding even with a record address', async () => {
  const bindTask = vi.fn()
  const api = canonicalCloudTaskPort(
    { bindTask } as unknown as WeworkWorkspaceRuntimePort,
    vi.fn().mockRejectedValue(new Error('Runtime offline')),
    unknownDevice
  )
  await expect(
    api.bindTask('issue', { deviceId: 'app-record-42', taskId: 'task' })
  ).rejects.toThrow('Runtime offline')
  expect(bindTask).not.toHaveBeenCalled()
})

it.each(['cloud', 'remote'] as const)(
  'uses the backend catalog identity for a registered %s device without an alias RPC',
  async device_type => {
    const port = {
      findIssueForTask: vi.fn(),
      findCloudContextForTask: vi.fn(),
      bindTask: vi.fn(),
      unbindTask: vi.fn(),
      unbindCloudContext: vi.fn(),
      trackProjectTask: vi.fn(),
    }
    const identity = vi.fn().mockRejectedValue(new Error('Unsupported identity RPC'))
    const task = { deviceId: 'registered-cloud-device', taskId: 'existing' }
    const api = canonicalCloudTaskPort(
      port as unknown as WeworkWorkspaceRuntimePort,
      identity,
      async () => ({ device_id: task.deviceId, device_type })
    )

    await api.findIssueForTask(task)
    await api.findCloudContextForTask(task)
    await api.bindTask('issue', task)
    await api.unbindTask('issue', task)
    await api.unbindCloudContext(task)
    await api.trackProjectTask('project', task, 'Title', 'Description')

    expect(identity).not.toHaveBeenCalled()
    expect(port.findIssueForTask).toHaveBeenCalledExactlyOnceWith(task)
    expect(port.findCloudContextForTask).toHaveBeenCalledExactlyOnceWith(task)
    expect(port.bindTask).toHaveBeenCalledExactlyOnceWith('issue', task, undefined, undefined)
    expect(port.unbindTask).toHaveBeenCalledExactlyOnceWith('issue', task)
    expect(port.unbindCloudContext).toHaveBeenCalledExactlyOnceWith(task)
    expect(port.trackProjectTask).toHaveBeenCalledExactlyOnceWith(
      'project',
      task,
      'Title',
      'Description'
    )
  }
)

it('still attests a local alias even when the catalog resolves it to a cloud registration', async () => {
  const findIssueForTask = vi.fn()
  const identity = vi.fn().mockRejectedValue(new Error('Ambiguous alias'))
  const api = canonicalCloudTaskPort(
    { findIssueForTask } as unknown as WeworkWorkspaceRuntimePort,
    identity,
    async () => ({ device_id: 'registered-cloud-device', device_type: 'cloud' })
  )

  await expect(api.findIssueForTask({ deviceId: 'alias', taskId: 'task' })).rejects.toThrow(
    'Ambiguous alias'
  )
  expect(findIssueForTask).not.toHaveBeenCalled()
})
