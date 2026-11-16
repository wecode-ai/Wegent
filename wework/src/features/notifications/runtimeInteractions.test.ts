// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  canQuickReply,
  canReplyToInteraction,
  interactionSource,
  interactionOriginalScheme,
  readRuntimeInteractions,
} from './runtimeInteractions'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

function reader(...pages: ReturnType<typeof interactionTranscript>[]) {
  const getRuntimeTranscript = vi.fn()
  for (const page of pages) getRuntimeTranscript.mockResolvedValueOnce(page)
  return { getRuntimeTranscript } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
}

describe('runtime human interactions', () => {
  it.each([
    { initiatedBy: undefined, expected: 'project' },
    { initiatedBy: 'stand_in' as const, expected: 'stand_in' },
  ])(
    'classifies the transcript origin as $expected independently of sidebar metadata',
    async ({ initiatedBy, expected }) => {
      const [item] = await readRuntimeInteractions(
        interactionTask,
        reader({
          ...interactionTranscript(),
          origin: {
            type: 'board_comment',
            cloudProjectId: '12',
            loopItemId: 'ISSUE-1',
            initiatedBy,
          },
        })
      )
      expect(interactionSource(item)).toBe(expected)
    }
  )
  it('keeps source message identities from the question own turn across transcript pages', async () => {
    const older = interactionTranscript()
    older.turns = [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'native-user-item',
            type: 'user_message',
            message: {
              id: 'native-user-item',
              clientUserMessageId: 'original-comment',
              role: 'user',
              content: 'Review',
              status: 'done',
            },
          },
        ],
      },
    ]
    const recent = interactionTranscript({ ...interactionQuestion, itemId: 'later' }, 'turn-2')
    recent.hasMoreBefore = true
    recent.beforeCursor = 'older'
    const requests = await readRuntimeInteractions(interactionTask, reader(recent, older))
    expect(
      requests.find(item => item.requestKey === 'item:compatibility-choice')?.sourceMessageIds
    ).toEqual(['original-comment', 'native-user-item'])
    expect(
      requests.find(item => item.requestKey === 'item:later')?.sourceMessageIds
    ).toBeUndefined()
  })
  it('uses the native localized approval description rather than an internal reason enum', async () => {
    const [item] = await readRuntimeInteractions(
      interactionTask,
      reader(
        interactionTranscript({
          kind: 'request_user_input',
          requestId: 41,
          interactionKind: 'approval',
          approvalKind: 'command',
          command: 'git status',
          reason: 'command',
        })
      )
    )
    expect(item.question).toBe(
      i18n.t('chat:request_user_input.approval_command', { detail: 'git status' })
    )
    expect(item.question).not.toBe('command')
    expect(canReplyToInteraction(item)).toBe(false)
  })
  it('finds older pending questions beyond the first history page', async () => {
    const recent = interactionTranscript({ ...interactionQuestion, itemId: 'recent' }, 'turn-2')
    recent.hasMoreBefore = true
    recent.beforeCursor = 'older'
    const api = reader(recent, interactionTranscript())
    const requests = await readRuntimeInteractions(interactionTask, api)
    expect(requests.map(item => item.requestKey)).toEqual([
      'item:compatibility-choice',
      'item:recent',
    ])
    expect(api.getRuntimeTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeCursor: 'older' })
    )
  })

  it('resolves an async question answered in a later page instead of reopening it', async () => {
    const newer = {
      ...interactionTranscript(),
      messages: [{ id: 'answer', role: 'user', content: 'Keep old behavior', status: 'done' }],
      hasMoreBefore: true,
      beforeCursor: 'older',
    }
    const requests = await readRuntimeInteractions(
      interactionTask,
      reader(newer, interactionTranscript())
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].answered).toBe(true)
  })

  it('keeps reusable synchronous request IDs scoped to their owning turn', async () => {
    const payload = { ...interactionQuestion, delivery: undefined, itemId: undefined, requestId: 1 }
    const recent = {
      ...interactionTranscript(payload, 'new-turn'),
      hasMoreBefore: true,
      beforeCursor: 'old',
    }
    const requests = await readRuntimeInteractions(
      interactionTask,
      reader(recent, interactionTranscript(payload, 'old-turn'))
    )
    expect(new Set(requests.map(item => item.id)).size).toBe(2)
    expect(requests.map(item => item.payload.interactionScope)).toEqual(['old-turn', 'new-turn'])
  })

  it('rejects incomplete pagination rather than presenting an incomplete queue', async () => {
    const page = { ...interactionTranscript(), hasMoreBefore: true, beforeCursor: 'same' }
    await expect(readRuntimeInteractions(interactionTask, reader(page, page))).rejects.toThrow(
      'Incomplete'
    )
  })

  it.each([
    { ...interactionQuestion, approvalKind: 'command' },
    { ...interactionQuestion, interactionKind: 'mcp_form' },
    { ...interactionQuestion, mode: 'url' as const },
    {
      ...interactionQuestion,
      questions: [
        { id: 'mcp_tool_call_approval_1', question: 'Allow?', options: [{ label: 'Allow' }] },
      ],
    },
  ])('keeps approval and authorization on their native path', payload => {
    expect(canQuickReply(payload)).toBe(false)
  })

  it.each(['board_comment', 'board_task', 'issue_dispatch', 'project_automation'] as const)(
    'restores the owning Issue thread from %s without treating read scope as send authority',
    async type => {
      const response = {
        ...interactionTranscript(),
        origin: {
          type,
          cloudProjectId: '12',
          loopItemId: 'ISSUE-1',
          rootCommentId: 'root',
          projectStore: 'local',
        },
      }
      const [item] = await readRuntimeInteractions(interactionTask, reader(response))
      expect(interactionOriginalScheme(item)).toBe(
        'wework://boards/local/12/issues/ISSUE-1/comments/root'
      )
      expect(canReplyToInteraction(item)).toBe(true)
      expect(
        canReplyToInteraction({ ...item, project: { ...item.project!, rootCommentId: undefined } })
      ).toBe(false)
      expect(
        canReplyToInteraction({
          ...item,
          project: undefined,
          task: {
            ...item.task,
            address: {
              ...item.task.address,
              projectSession: { projectId: '12', issueId: 'ISSUE-1' },
            },
          },
        })
      ).toBe(false)
    }
  )
})
