import { describe, expect, it, vi } from 'vitest'
import { archiveMobileConversation } from './mobileConversationArchive'
const address = { deviceId: 'app-record-11', taskId: 'task', workspacePath: '/managed/task/repo' }
describe('PC task-bound archive cleanup', () => {
  it('requests cleanup on the owning executor without a client-selected deletion path', async () => {
    const api = { archiveConversation: vi.fn().mockResolvedValue({ accepted: true }) }
    await expect(archiveMobileConversation(api, address)).resolves.toEqual({ cleanupError: null })
    expect(api.archiveConversation).toHaveBeenCalledExactlyOnceWith({
      ...address,
      cleanupWorktree: true,
    })
  })
  it('preserves archive rejection', async () => {
    const api = {
      archiveConversation: vi.fn().mockResolvedValue({ accepted: false, error: 'Still running' }),
    }
    await expect(archiveMobileConversation(api, address)).rejects.toThrow('Still running')
  })
  it('distinguishes accepted archival from failed snapshot cleanup', async () => {
    const api = {
      archiveConversation: vi
        .fn()
        .mockResolvedValue({ accepted: true, cleanupError: 'Snapshot unavailable' }),
    }
    await expect(archiveMobileConversation(api, address)).resolves.toEqual({
      cleanupError: '会话已归档，但工作树清理失败：Snapshot unavailable',
    })
    expect(api.archiveConversation).toHaveBeenCalledTimes(1)
  })
})
