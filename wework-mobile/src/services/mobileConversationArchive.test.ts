import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/runtime'
import { archiveMobileConversation } from './mobileConversationArchive'

const address = { deviceId: 'cloud-a', taskId: 'task-a', workspacePath: '/worktrees/a/repo' }
const workspace = {
  deviceId: address.deviceId,
  deviceName: 'Cloud',
  deviceStatus: 'online',
  available: true,
  workspacePath: '/repo',
  tasks: [
    {
      taskId: address.taskId,
      title: 'Task',
      runtime: 'codex',
      workspacePath: address.workspacePath,
      workspaceKind: 'worktree',
      worktreeId: 'a',
    },
  ],
}
const work: RuntimeWorkListResponse = { projects: [], chats: [workspace], totalTasks: 1 }
function setup() {
  return {
    archiveConversation: vi.fn().mockResolvedValue({ accepted: true }),
    deleteWorktree: vi.fn().mockResolvedValue({ success: true }),
  }
}

describe('Mobile follows PC conversation archive/worktree ordering', () => {
  it('preserves a worktree snapshot only after accepted archive and uses its owning device', async () => {
    const api = setup()
    await expect(archiveMobileConversation(api, work, address)).resolves.toEqual({
      cleanupError: null,
    })
    expect(api.archiveConversation).toHaveBeenCalledWith(address)
    expect(api.deleteWorktree).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'cloud-a',
      path: address.workspacePath,
      preserveSnapshot: true,
    })
    expect(api.archiveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      api.deleteWorktree.mock.invocationCallOrder[0]!
    )
  })
  it('never deletes a worktree after a rejected archive', async () => {
    const api = setup()
    api.archiveConversation.mockResolvedValue({ accepted: false, error: 'Still running' })
    await expect(archiveMobileConversation(api, work, address)).rejects.toThrow('Still running')
    expect(api.deleteWorktree).not.toHaveBeenCalled()
  })
  it.each([
    { ...address, deviceId: 'other' },
    { ...address, workspacePath: '/other' },
  ])('never cleans another device or workspace', async other => {
    const api = setup()
    await archiveMobileConversation(api, work, other)
    expect(api.deleteWorktree).not.toHaveBeenCalled()
  })
  it('does not treat ordinary project directories as managed worktrees', async () => {
    const api = setup()
    await archiveMobileConversation(
      api,
      {
        ...work,
        chats: [
          {
            ...workspace,
            tasks: workspace.tasks.map(task => ({
              ...task,
              workspaceKind: 'directory',
              worktreeId: undefined,
            })),
          },
        ],
      },
      address
    )
    expect(api.deleteWorktree).not.toHaveBeenCalled()
  })
  it('reports cleanup failure truthfully after the conversation was already archived', async () => {
    const api = setup()
    api.deleteWorktree.mockRejectedValue(new Error('Snapshot could not be saved'))
    await expect(archiveMobileConversation(api, work, address)).resolves.toEqual({
      cleanupError: '会话已归档，但工作树清理失败：Snapshot could not be saved',
    })
    expect(api.archiveConversation).toHaveBeenCalledTimes(1)
  })
})
