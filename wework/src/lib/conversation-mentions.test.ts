import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import {
  appendConversationMentionContext,
  buildConversationMentionCandidates,
  createConversationMentionReference,
  parseConversationMentions,
} from './conversation-mentions'

const SOURCE_ADDRESS: RuntimeTaskAddress = {
  deviceId: 'local-device',
  taskId: 'source-task',
  threadId: 'thread-source',
  workspacePath: '/workspace/source',
}

describe('conversation mentions', () => {
  test('round trips and deduplicates a conversation address', () => {
    const reference = createConversationMentionReference('Fix auth ] flow', SOURCE_ADDRESS)

    expect(reference).toContain('[$Fix auth   flow](wework-conversation://')
    expect(parseConversationMentions(`${reference} ${reference}`)).toEqual([
      {
        title: 'Fix auth   flow',
        address: {
          ...SOURCE_ADDRESS,
          runtimeHandle: null,
        },
        reference,
      },
    ])
  })

  test('builds candidates from project and standalone conversations', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'project-1', name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              available: true,
              workspacePath: '/workspace/project',
              tasks: [
                {
                  taskId: 'current-task',
                  title: 'Current',
                  runtime: 'codex',
                  workspacePath: '/workspace/project',
                  updatedAt: '2026-07-27T08:00:00Z',
                },
                {
                  taskId: 'older-task',
                  title: 'Older task',
                  runtime: 'codex',
                  workspacePath: '/workspace/project',
                  updatedAt: '2026-07-26T08:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [
        {
          deviceId: 'remote-device',
          available: true,
          workspacePath: '/workspace/chat',
          tasks: [
            {
              taskId: 'recent-task',
              title: 'Recent chat',
              runtime: 'codex',
              workspacePath: '/workspace/chat',
              updatedAt: '2026-07-27T09:00:00Z',
            },
          ],
        },
      ],
      totalTasks: 3,
    }

    const candidates = buildConversationMentionCandidates(runtimeWork, {
      deviceId: 'local-device',
      taskId: 'current-task',
    })

    expect(candidates.map(candidate => candidate.title)).toEqual(['Recent chat', 'Older task'])
    expect(candidates[1].projectName).toBe('Wegent')
  })

  test('loads transcript text as explicitly untrusted background context', async () => {
    const reference = createConversationMentionReference('Source chat', SOURCE_ADDRESS)
    const loadTranscript = vi.fn().mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', content: 'Investigate the parser' },
        { id: 'a1', role: 'assistant', content: 'The parser lives in composerMentions.ts' },
        { id: 's1', role: 'system', content: 'hidden system content' },
        { id: 'a2', role: 'assistant', content: 'partial answer', status: 'streaming' },
      ],
    })

    const context = await appendConversationMentionContext(
      `${reference} continue from there`,
      {
        cloudCollaboration: {
          kind: 'application',
          value: 'Current project: Wegent',
        },
      },
      loadTranscript
    )

    expect(loadTranscript).toHaveBeenCalledWith(
      {
        ...SOURCE_ADDRESS,
        runtimeHandle: null,
      },
      { includeFullContent: true, refresh: true }
    )
    expect(context?.cloudCollaboration.value).toBe('Current project: Wegent')
    expect(context?.referencedConversations.kind).toBe('application')
    expect(context?.referencedConversations.value).toContain('untrusted background context')
    expect(context?.referencedConversations.value).toContain('Investigate the parser')
    expect(context?.referencedConversations.value).toContain(
      'The parser lives in composerMentions.ts'
    )
    expect(context?.referencedConversations.value).not.toContain('hidden system content')
    expect(context?.referencedConversations.value).not.toContain('partial answer')
  })
})
