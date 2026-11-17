import { describe, expect, it, vi } from 'vitest'
vi.mock('expo-file-system', () => ({ File: class {} }))
import { RuntimeApi } from './runtimeApi'

describe('typed management transport uses the selected runtime', () => {
  it.each(['app-record-11', 'phone-local:test'])(
    'routes every mutation to %s without raw device commands',
    async deviceId => {
      const request = vi.fn(async (..._args: unknown[]) => ({ accepted: true }))
      const api = new RuntimeApi(null, undefined, undefined, {
        request,
        executeCommand: vi.fn(),
      } as unknown as ConstructorParameters<typeof RuntimeApi>[3])
      const address = { deviceId, taskId: 'task', workspacePath: '/repo' }
      await api.upsertLocalProject({
        deviceId,
        projectKey: 'project',
        name: 'Project',
        roots: ['/repo'],
        runtime: 'codex',
      })
      await api.renameWorkspace({
        deviceId,
        projectKey: 'project',
        workspacePath: '/repo',
        name: 'Renamed',
        runtime: 'codex',
      })
      await api.setProjectPinned({ deviceId, projectKey: 'project', pinned: true })
      await api.removeWorkspace({
        deviceId,
        projectKey: 'project',
        workspacePath: '/repo',
        runtime: 'codex',
      })
      await api.setRuntimeTaskPinned({ deviceId, threadId: 'thread', pinned: true })
      await api.renameRuntimeTask({ address, title: 'Renamed' })
      await api.archiveConversation({ ...address, cleanupWorktree: true })
      await api.listArchivedConversations({ deviceId })
      await api.unarchiveConversation(address)
      await api.deleteArchivedConversation(address)
      expect(request.mock.calls.map(call => (call as unknown[])[0])).toEqual([
        'runtime.projects.upsert_local',
        'runtime.workspaces.rename',
        'runtime.sidebar.projects.pin',
        'runtime.workspaces.remove',
        'runtime.sidebar.tasks.pin',
        'runtime.tasks.rename',
        'runtime.tasks.archive',
        'runtime.archived_conversations.list',
        'runtime.archived_conversations.unarchive',
        'runtime.archived_conversations.delete',
      ])
      expect(request.mock.calls.every(call => (call as unknown[])[2] === deviceId)).toBe(true)
      expect(request.mock.calls[6]![1]).toEqual({ ...address, cleanupWorktree: true })
    }
  )
})
