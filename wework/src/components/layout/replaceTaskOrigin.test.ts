import { describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import type { ProjectTaskRuntimeApi } from '@/features/workbench/projectTaskTracking'
import { replaceTaskOrigin } from './replaceTaskOrigin'

const task = {
  deviceId: 'private-device',
  taskId: 'original-private-task',
  workspacePath: '/private/original-worktree',
  runtimeHandle: { modelSelection: { modelName: 'private-model', modelType: 'private' as const } },
}
const item = (id: string) => ({ id, title: id }) as CloudLoopItem

function setup(source: 'local' | 'cloud', destination: 'local' | 'cloud') {
  const trace: string[] = []
  const old = {
    unbindTask: vi.fn(async () => {
      trace.push(`${source}:unbind`)
    }),
    bindTask: vi.fn(async () => {
      trace.push(`${source}:restore`)
    }),
    unbindCloudContext: vi.fn(),
  }
  const target = {
    bindTask: vi.fn(async () => {
      trace.push(`${destination}:bind`)
    }),
    unbindTask: vi.fn(),
  }
  const previousItem = item('previous-thread')
  const targetItem = item('target-thread')
  const args = {
    previous: { api: old as unknown as ProjectTaskRuntimeApi, item: previousItem },
    target: target as unknown as ProjectTaskRuntimeApi,
    task,
    title: 'Private task title',
    current: () => true,
    recoveryFailed: 'Recovery failed',
    link: async () => {
      await target.bindTask()
      return targetItem
    },
  }
  return { old, target, previousItem, targetItem, args, trace }
}

describe('Replacing a private task link across stores', () => {
  it.each([
    ['local', 'cloud'],
    ['cloud', 'local'],
  ] as const)(
    'removes only the exact previous link before binding from %s to %s',
    async (source, destination) => {
      const { args, old, target, targetItem, trace } = setup(source, destination)
      await expect(replaceTaskOrigin(args)).resolves.toBe(targetItem)
      expect(trace).toEqual([`${source}:unbind`, `${destination}:bind`])
      expect(old.unbindTask).toHaveBeenCalledExactlyOnceWith('previous-thread', task)
      expect(old.unbindCloudContext).not.toHaveBeenCalled()
      expect(old.bindTask).not.toHaveBeenCalled()
      expect(target.unbindTask).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['local', 'cloud'],
    ['cloud', 'local'],
  ] as const)(
    'restores the same private task, model and workspace if the %s to %s target fails',
    async (source, destination) => {
      const { args, old, target, trace } = setup(source, destination)
      const cause = new Error('Target binding failed')
      target.bindTask.mockRejectedValue(cause)
      await expect(replaceTaskOrigin(args)).rejects.toBe(cause)
      expect(trace).toEqual([`${source}:unbind`, `${source}:restore`])
      expect(old.bindTask).toHaveBeenCalledExactlyOnceWith(
        'previous-thread',
        task,
        'Private task title'
      )
      expect(target.unbindTask).not.toHaveBeenCalled()
    }
  )

  it('does not touch the target when the old link cannot be removed', async () => {
    const { args, old, target } = setup('local', 'cloud')
    old.unbindTask.mockRejectedValue(new Error('Source access revoked'))
    await expect(replaceTaskOrigin(args)).rejects.toThrow('Source access revoked')
    expect(target.bindTask).not.toHaveBeenCalled()
    expect(old.bindTask).not.toHaveBeenCalled()
  })

  it('reports both errors when restoring the old link fails, without deleting a pre-existing target link', async () => {
    const { args, old, target } = setup('cloud', 'local')
    const cause = new Error('Target failure')
    const recovery = new Error('Restore failure')
    target.bindTask.mockRejectedValue(cause)
    old.bindTask.mockRejectedValue(recovery)
    const error = await replaceTaskOrigin(args).catch(value => value)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe('Recovery failed')
    expect(error.errors).toEqual([cause, recovery])
    expect(target.unbindTask).not.toHaveBeenCalled()
  })

  it('leaves same-store replacement to its existing atomic binding transaction', async () => {
    const { args, target, targetItem } = setup('local', 'cloud')
    args.previous.api = args.target
    await expect(replaceTaskOrigin(args)).resolves.toBe(targetItem)
    expect(target.unbindTask).not.toHaveBeenCalled()
  })

  it('keeps the system My Tasks binding when no extra source link is supplied', async () => {
    const { args, old, targetItem } = setup('local', 'cloud')
    await expect(replaceTaskOrigin({ ...args, previous: null })).resolves.toBe(targetItem)
    expect(old.unbindTask).not.toHaveBeenCalled()
  })

  it('does not issue further requests after an account or API scope change', async () => {
    const { args, old, target } = setup('local', 'cloud')
    let current = true
    old.unbindTask.mockImplementation(async () => {
      current = false
    })
    await expect(replaceTaskOrigin({ ...args, current: () => current })).resolves.toBeNull()
    expect(target.bindTask).not.toHaveBeenCalled()
    expect(old.bindTask).not.toHaveBeenCalled()
  })
})
