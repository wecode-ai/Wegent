// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationExecution, WorkspaceTaskBinding } from '@wegent/collaboration'
import { openThreadExecution } from './threadExecutionNavigation'
import { activityFixture } from './threadExecutionActivity.test-support'

function setup() {
  const fixture = activityFixture()
  fixture.message.runtimeAddress = { deviceId: 'device', taskId: 'runtime' }
  vi.mocked(fixture.api.executions!.list).mockResolvedValue([
    {
      id: 15,
      loop_item_id: 'T-1',
      cloud_project_id: 'group',
      runtime_task_id: 'runtime',
      runtime_device_id: 'device',
    },
  ] as CollaborationExecution[])
  const open = vi.fn().mockResolvedValue(undefined)
  const input = {
    context: fixture.context,
    message: fixture.message,
    open,
    isCurrent: fixture.isCurrent,
    unavailable: 'Unavailable',
  }
  return { ...fixture, open, input }
}

describe('Execution navigation retains independent Runtime authorization', () => {
  it('uses the recorded runtime address after current group read and exact execution lookup', async () => {
    const { input, open } = setup()
    await openThreadExecution(input)
    expect(open).toHaveBeenCalledExactlyOnceWith({ deviceId: 'device', taskId: 'runtime' })
  })

  it('does not turn read access into execution permission or require joining to read', async () => {
    const { input, item, participation, open, api } = setup()
    item.permissions!.execute = false
    participation.joined = false
    await openThreadExecution(input)
    expect(open).toHaveBeenCalledOnce()
    expect(api.issues.update).not.toHaveBeenCalled()
  })

  it.each(['group', 'thread', 'runtime', 'device'] as const)(
    'rejects an execution associated with another %s',
    async field => {
      const { input, api, open } = setup()
      vi.mocked(api.executions!.list).mockResolvedValue([
        {
          id: 15,
          loop_item_id: field === 'thread' ? 'other' : 'T-1',
          cloud_project_id: field === 'group' ? 'other' : 'group',
          runtime_task_id: field === 'runtime' ? 'other' : 'runtime',
          runtime_device_id: field === 'device' ? 'other-device' : 'device',
        },
      ] as CollaborationExecution[])
      await expect(openThreadExecution(input)).rejects.toThrow('Unavailable')
      expect(open).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, null, ''])(
    'refuses navigation when the stored execution device is missing (%s)',
    async deviceId => {
      const { input, api, open } = setup()
      vi.mocked(api.executions!.list).mockResolvedValue([
        {
          id: 15,
          loop_item_id: 'T-1',
          cloud_project_id: 'group',
          runtime_task_id: 'runtime',
          runtime_device_id: deviceId,
        },
      ] as CollaborationExecution[])
      await expect(openThreadExecution(input)).rejects.toThrow('Unavailable')
      expect(open).not.toHaveBeenCalled()
    }
  )

  it('does not inspect a personal stand-in Runtime through its public reply', async () => {
    const { input, message, open } = setup()
    message.metadata = {
      execution_id: 15,
      execution_dispatch: 'comment_only',
      stand_in: { user_id: 7 },
    }
    await expect(openThreadExecution(input)).rejects.toThrow('Unavailable')
    expect(open).not.toHaveBeenCalled()
  })

  it('uses explicit own bindings for pre-queue history and refuses another person’s binding', async () => {
    const { input, message, api, open } = setup()
    message.metadata = {}
    const binding = {
      projectId: 'group',
      issueId: 'T-1',
      taskId: 'runtime',
      deviceId: 'device',
      taskUserId: 8,
    } as WorkspaceTaskBinding
    api.taskBindings = { list: vi.fn(async () => [binding]) } as never
    await expect(openThreadExecution(input)).rejects.toThrow('Unavailable')
    expect(open).not.toHaveBeenCalled()
    binding.taskUserId = 7
    await openThreadExecution(input)
    expect(open).toHaveBeenCalledOnce()
  })

  it('propagates independent Runtime denial without changing grants or choosing another route', async () => {
    const { input, open, api } = setup()
    open.mockRejectedValue(new Error('Device access denied'))
    await expect(openThreadExecution(input)).rejects.toThrow('Device access denied')
    expect(open).toHaveBeenCalledOnce()
    expect(api.issues.update).not.toHaveBeenCalled()
  })

  it('does not navigate after the current source is replaced during execution lookup', async () => {
    const { input, api, open, isCurrent } = setup()
    vi.mocked(api.executions!.list).mockImplementation(async () => {
      isCurrent.mockReturnValue(false)
      return []
    })
    await expect(openThreadExecution(input)).rejects.toThrow('Unavailable')
    expect(open).not.toHaveBeenCalled()
  })
})
