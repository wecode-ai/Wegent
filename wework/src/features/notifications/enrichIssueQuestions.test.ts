import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueHumanInteraction } from './issueHumanInteractions'
import { canReplyToInteraction, type RuntimeInteraction } from './runtimeInteractions'
import { createIssueQuestionEnricher } from './enrichIssueQuestions'

vi.mock('./interactionDiagnostics', () => ({ logInteractionLoadFailure: vi.fn() }))

const shared = {
  id: 'canonical',
  project_id: '12',
  issue_id: 'issue',
  root_comment_id: 'root',
  runtime_device_id: 'device',
  runtime_task_id: 'runtime',
  item_id: 'question',
  question: 'Scope?',
  recipient_user_id: 7,
  responsible_user_id: 7,
  blocks_progress: true,
  status: 'pending' as const,
  version: 1,
  created_at: '2026-11-07T00:00:00Z',
  updated_at: '2026-11-07T00:00:00Z',
}
function native(store: 'local' | 'backend' = 'local'): RuntimeInteraction {
  return { ...issueHumanInteraction(shared, store), id: 'native', sharedRequest: undefined }
}
function fixture(list = vi.fn().mockResolvedValue({ items: [shared] })) {
  const services = {
    localIssueHumanRequestsApi: { list },
    issueHumanRequestsApi: { list },
    localParticipationIdentity: {
      nativeOwnerUserId: 0,
      currentUser: { id: 7, user_name: 'Profile' },
      viewerUserIds: [0, 7],
    },
  } as unknown as WorkbenchServices
  return { list, services }
}

describe('optional Issue question enrichment', () => {
  it('does not address an unassigned cloud question to a missing authenticated user', async () => {
    const { services } = fixture(
      vi.fn().mockResolvedValue({
        items: [{ ...shared, recipient_user_id: null, responsible_user_id: undefined }],
      })
    )
    expect(
      await createIssueQuestionEnricher(services, undefined, () => [])([native('backend')])
    ).toEqual([])
  })
  it('distinguishes a successful empty list from an unavailable authority lookup', async () => {
    const { services } = fixture(vi.fn().mockResolvedValue({ items: [] }))
    const question = native()
    const result = await createIssueQuestionEnricher(services, 7, () => [])([question])
    expect(result).toEqual([question])
    expect(canReplyToInteraction(result[0])).toBe(true)
  })
  it('shares one Issue lookup across concurrent transcript questions in a poll', async () => {
    const { services, list } = fixture()
    const enrich = createIssueQuestionEnricher(services, 7, () => [])
    const [first, second] = await Promise.all([enrich([native()]), enrich([native()])])
    expect(list).toHaveBeenCalledTimes(1)
    expect(first[0].sharedRequest?.id).toBe('canonical')
    expect(second[0].sharedRequest?.id).toBe('canonical')
  })

  it('retains the native question on lookup failure without granting reply authority', async () => {
    const { services } = fixture(vi.fn().mockRejectedValue(new Error('Offline')))
    const result = await createIssueQuestionEnricher(services, 7, () => [])([native()])
    expect(result).toHaveLength(1)
    expect(result[0].question).toBe('Scope?')
    expect(canReplyToInteraction(result[0])).toBe(false)
  })

  it('does not duplicate a question already owned by the inbox when enrichment fails', async () => {
    const { services } = fixture(vi.fn().mockRejectedValue(new Error('Offline')))
    expect(
      await createIssueQuestionEnricher(services, 7, () => [
        issueHumanInteraction(shared, 'local'),
      ])([native()])
    ).toEqual([])
  })

  it.each([0, 7])('discovers the explicitly composed local viewer %i', async recipient => {
    const { services } = fixture(
      vi.fn().mockResolvedValue({
        items: [{ ...shared, recipient_user_id: recipient, can_reply: recipient === 7 }],
      })
    )
    const [result] = await createIssueQuestionEnricher(services, 99, () => [])([native()])
    expect(result.sharedRequest?.recipient_user_id).toBe(recipient)
    expect(canReplyToInteraction(result)).toBe(recipient === 7)
  })

  it('does not treat another local user or cloud user as part of the local viewer scope', async () => {
    const { services } = fixture(
      vi.fn().mockResolvedValue({ items: [{ ...shared, recipient_user_id: 8 }] })
    )
    expect(await createIssueQuestionEnricher(services, 8, () => [])([native()])).toEqual([])
    const cloud = fixture()
    expect(
      await createIssueQuestionEnricher(cloud.services, 9, () => [])([native('backend')])
    ).toEqual([])
  })
})
