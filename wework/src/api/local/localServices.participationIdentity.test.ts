import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import type { LocalCommentRecord } from './localProjectChatClient'
import type { User } from '@/types/api'

const status = { running: true, ready: true, deviceId: 'device', runtimeInstanceId: 'runtime' }
const historical: LocalCommentRecord = {
  id: 1,
  message_id: 'historical',
  client_message_id: 'historical',
  project_id: 'p',
  task_id: 'i',
  sender_type: 'user',
  sender_id: '0',
  sender_name: 'local',
  message_type: 'text',
  content: 'Existing',
  metadata: {},
  trigger_message_id: null,
  reply_to_message_id: null,
  thread_root_message_id: 'historical',
  status: 'completed',
  sequence_number: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
}

describe('local participation identity composition', () => {
  beforeEach(() => localStorage.clear())

  it.each([undefined, 7, 8])(
    'uses only the current profile %s and local owner for discovery',
    async id => {
      const user: User | undefined = id == null ? undefined : { id, user_name: `profile-${id}` }
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'todos.comment.list') return [historical]
        if (method === 'todos.comment.create')
          return { ...historical, ...(params?.comment as object), message_id: 'new' }
        if (method === 'todos.humanRequests.inbox') return { items: [] }
        if (method === 'runtime.tasks.list') return { workspaces: [] }
        return {}
      })
      const services = createLocalAppServices({
        user,
        request,
        available: async () => status,
        ensure: async () => status,
        subscribe: vi.fn().mockResolvedValue(vi.fn()),
      })
      const author = id ?? 0
      const viewerIds = id == null ? [0] : [0, id]
      expect(services.localParticipationIdentity).toEqual({
        nativeOwnerUserId: 0,
        currentUser: { id: author, user_name: user?.user_name ?? 'local' },
        viewerUserIds: viewerIds,
      })
      const subscription = await services.localProjectChatClient!.subscribe('p', 'i', 0, vi.fn())
      try {
        expect(subscription.snapshot.currentUserId).toBe(String(author))
        expect(subscription.snapshot.messages[0].sender.id).toBe('0')
        await services.localProjectChatClient!.send({
          projectId: 'p',
          taskId: 'i',
          clientMessageId: 'new',
          text: 'Answer',
        })
        expect(request).toHaveBeenCalledWith(
          'todos.comment.create',
          expect.objectContaining({
            comment: expect.objectContaining({
              sender_id: String(author),
              sender_name: user?.user_name ?? 'local',
            }),
          })
        )
        await services.localIssueHumanRequestsApi!.inbox()
        expect(request).toHaveBeenCalledWith('todos.humanRequests.inbox', { user_ids: viewerIds })
        await services.runtimeWorkApi!.listRuntimeWork({ pendingOnly: true })
        expect(request).toHaveBeenCalledWith('runtime.tasks.list', {
          pendingOnly: true,
          localIssueUserIds: viewerIds,
        })
        request.mockClear()
        await services.runtimeWorkApi!.listRuntimeWork()
        expect(request).toHaveBeenCalledWith('runtime.tasks.list', {})
      } finally {
        subscription.unsubscribe()
        services.localProjectChatClient!.dispose?.()
      }
    }
  )
})
