import { describe, expect, it, vi } from 'vitest'
import type { IssueHumanRequest } from '@wegent/collaboration'
import type { LocalParticipationIdentity } from '@/features/workbench/workbenchServices'
import type { HttpClient } from './http'
import { createIssueHumanRequestsApi, createLocalIssueHumanRequestsApi } from './issueHumanRequests'

const identity: LocalParticipationIdentity = {
  nativeOwnerUserId: 0,
  currentUser: { id: 7, user_name: 'profile-7' },
  viewerUserIds: [0, 7],
}
const question = (recipient: number, status = 'pending') =>
  ({
    id: `question-${recipient}`,
    status,
    recipient_user_id: recipient,
    waiting_since: '2026-11-01T00:00:00Z',
  }) as IssueHumanRequest

describe('Issue human request identity scope', () => {
  it('discovers native owner and current profile without granting alias replies', async () => {
    const items = [question(0), question(7), question(8), question(7, 'answering')]
    const request = vi.fn().mockResolvedValue({ items })
    const api = createLocalIssueHumanRequestsApi(request, identity)
    const response = await api.inbox()
    expect(request).toHaveBeenCalledExactlyOnceWith('todos.humanRequests.inbox', {
      user_ids: [0, 7],
    })
    expect(response.items.map(item => item.can_reply)).toEqual([false, true, false, false])
    expect(response.items.map(item => item.recipient_user_id)).toEqual([0, 7, 8, 7])
    expect(response.items.every(item => item.waiting_since === items[0].waiting_since)).toBe(true)
    expect(items.every(item => item.can_reply === undefined)).toBe(true)
    request.mockClear()
    await expect(api.inbox([8])).rejects.toThrow('identity does not match')
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the same exact author capabilities for lists and explicit assignment', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ items: [question(0), { ...question(7), can_assign: false }] })
      .mockResolvedValueOnce(question(7))
    const api = createLocalIssueHumanRequestsApi(request, identity)
    const listed = await api.list('project', 'issue')
    expect(listed.items.map(item => item.can_reply)).toEqual([false, true])
    expect(listed.items.map(item => item.can_assign)).toEqual([true, false])
    const assigned = await api.assign('project', 'issue', question(0), { id: 7, name: 'profile-7' })
    expect(assigned.can_reply).toBe(true)
    expect(request).toHaveBeenLastCalledWith(
      'todos.humanRequests.assign',
      expect.objectContaining({ recipient_user_id: 7 })
    )
  })

  it('never forwards local viewer aliases into cloud authorization', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] })
    const api = createIssueHumanRequestsApi({ get } as unknown as HttpClient)
    await api.inbox([0, 7])
    expect(get).toHaveBeenCalledExactlyOnceWith('/v1/wework-human-requests')
  })
})
