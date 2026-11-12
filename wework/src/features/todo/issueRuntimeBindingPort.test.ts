// @vitest-environment node

import type { WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueRuntimeBindingPort } from './issueRuntimeBindingPort'

describe('personal-task runtime binding follows the exact source store', () => {
  it('returns no local port when the local API is missing instead of using cloud', () => {
    const cloud = { bindTask: vi.fn(), unbindTask: vi.fn() }
    for (const projectSpaceApis of [undefined, {}]) {
      const services = {
        workspaceRuntimePort: cloud,
        projectSpaceApis,
      } as unknown as WorkbenchServices
      expect(issueRuntimeBindingPort(services, 'local')).toBeUndefined()
    }
    expect(cloud.bindTask).not.toHaveBeenCalled()
    expect(cloud.unbindTask).not.toHaveBeenCalled()
  })

  it('keeps the existing backend runtime port intact', () => {
    const cloud = { bindTask: vi.fn(), unbindTask: vi.fn() }
    const services = { workspaceRuntimePort: cloud } as unknown as WorkbenchServices
    expect(issueRuntimeBindingPort(services, 'backend')).toBe(cloud)
  })

  it('binds and unbinds through local storage with full runtime and dispatch identity', async () => {
    const local = {
      bindTask: vi.fn().mockResolvedValue(undefined),
      unbindTask: vi.fn().mockResolvedValue(undefined),
    }
    const cloud = { bindTask: vi.fn(), unbindTask: vi.fn() }
    const services = {
      workspaceRuntimePort: cloud,
      projectSpaceApis: { local },
    } as unknown as WorkbenchServices
    const task: WorkspaceRuntimeTaskAddress = {
      deviceId: 'device',
      taskId: 'runtime-task',
      backendTaskId: 0,
      wegentTeamId: 0,
      modelSelection: { modelName: 'chosen-model', modelType: 'public', options: {} },
    }
    const dispatch = {
      humanAssignmentId: 'human',
      dispatchId: 'dispatch',
      dispatchRoundId: 'round',
      assignmentId: 'assignment',
    }
    const address = {
      deviceId: 'device',
      taskId: 'runtime-task',
      backendTaskId: 0,
      runtimeHandle: { modelSelection: task.modelSelection, wegentTeam: { id: 0 } },
    }
    const port = issueRuntimeBindingPort(services, 'local')!
    await port.bindTask('thread', task, 'Personal task', dispatch)
    expect(local.bindTask).toHaveBeenCalledExactlyOnceWith(
      'thread',
      address,
      'Personal task',
      null,
      dispatch
    )
    await port.unbindTask('thread', task)
    expect(local.unbindTask).toHaveBeenCalledExactlyOnceWith('thread', address)
    expect(cloud.bindTask).not.toHaveBeenCalled()
    expect(cloud.unbindTask).not.toHaveBeenCalled()
  })

  it('preserves local bind failures rather than falling back to cloud', async () => {
    const failure = new Error('Local access revoked')
    const local = { bindTask: vi.fn().mockRejectedValue(failure) }
    const cloud = { bindTask: vi.fn() }
    const services = {
      workspaceRuntimePort: cloud,
      projectSpaceApis: { local },
    } as unknown as WorkbenchServices
    await expect(
      issueRuntimeBindingPort(services, 'local')!.bindTask('thread', { deviceId: 'd', taskId: 't' })
    ).rejects.toBe(failure)
    expect(cloud.bindTask).not.toHaveBeenCalled()
  })
})
