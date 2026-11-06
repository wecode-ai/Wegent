// @vitest-environment node

import type { RuntimeTaskAddress } from '@/types/api'
import { describe, expect, test, vi } from 'vitest'
import {
  appendConversationMentionContext,
  createConversationMentionReference,
  parseConversationMentionHref,
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

  test('parses a conversation mention href into a runtime task address', () => {
    const reference = createConversationMentionReference('Source chat', SOURCE_ADDRESS)
    const href = reference.slice(reference.indexOf('](') + 2, -1)

    expect(parseConversationMentionHref(href)).toEqual({
      ...SOURCE_ADDRESS,
      runtimeHandle: null,
    })
    expect(parseConversationMentionHref('https://example.com')).toBeNull()
  })

  test('preserves Issue execution context in a conversation reference', () => {
    const address: RuntimeTaskAddress = {
      ...SOURCE_ADDRESS,
      issueExecution: { projectId: 'project-1', issueId: 'issue-1' },
      projectSession: { projectId: 'project-1', issueId: 'issue-1' },
    }
    const reference = createConversationMentionReference('Issue chat', address)
    const href = reference.slice(reference.indexOf('](') + 2, -1)

    expect(parseConversationMentionHref(href)).toEqual({
      ...address,
      runtimeHandle: null,
    })
  })

  test('keeps runtime metadata parentheses inside the atomic reference', () => {
    const address: RuntimeTaskAddress = {
      ...SOURCE_ADDRESS,
      runtimeHandle: {
        modelSelection: {
          modelName: 'Kimi K3 (OpenAI)',
        },
      },
    }
    const reference = createConversationMentionReference('Source chat', address)

    expect(reference).toContain('Kimi%20K3%20%28OpenAI%29')
    expect(parseConversationMentions(reference)).toEqual([
      {
        title: 'Source chat',
        address,
        reference,
      },
    ])
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
      { includeFullContent: true, conversationContextOnly: true, refresh: true }
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
