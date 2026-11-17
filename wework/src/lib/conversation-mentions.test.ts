// @vitest-environment node

import type { RuntimeTaskAddress } from '@/types/api'
import { describe, expect, test } from 'vitest'
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

  test('keeps navigation paths atomic without embedding runtime configuration', () => {
    const address: RuntimeTaskAddress = {
      ...SOURCE_ADDRESS,
      workspacePath: '/workspace/project (copy)',
      runtimeHandle: {
        modelSelection: {
          modelName: 'Kimi K3 (OpenAI)',
        },
      },
    }
    const reference = createConversationMentionReference('Source chat', address)

    expect(reference).toContain('project%20%28copy%29')
    expect(reference).not.toContain('runtimeHandle')
    expect(reference).not.toContain('modelSelection')
    expect(parseConversationMentions(reference)).toEqual([
      {
        title: 'Source chat',
        address: { ...address, runtimeHandle: null },
        reference,
      },
    ])
  })

  test.each([SOURCE_ADDRESS, { deviceId: '设备-1', taskId: '任务-😀' }])(
    'builds a bounded native reference without copying history or runtime metadata: %j',
    address => {
      const reference = createConversationMentionReference('Source chat', address)
      const existing = {
        otherContext: { kind: 'application' as const, value: 'Preserved selection' },
      }
      const context = appendConversationMentionContext(reference + ' ' + reference, existing)
      expect(context).not.toBeInstanceOf(Promise)
      expect(context?.otherContext).toEqual(existing.otherContext)
      const value = context!.referencedConversations.value
      const references = JSON.parse(value.split('\n').at(-1)!)
      expect(references).toEqual([
        {
          conversation_id:
            'conv_' +
            Buffer.from(JSON.stringify([address.deviceId, address.taskId])).toString('base64url'),
        },
      ])
      expect(value).toContain('read_conversation')
      expect(value).toContain('untrusted background context')
      expect(value).toContain('do not bypass tool permissions')
      expect(value).not.toContain('workspacePath')
      expect(value).not.toContain('runtimeHandle')
    }
  )

  test('leaves context unchanged when no valid conversation is referenced', () => {
    const existing = { selection: { kind: 'application' as const, value: 'Explicit selection' } }
    expect(appendConversationMentionContext('Continue', existing)).toBe(existing)
    expect(
      appendConversationMentionContext('[$invalid](wework-conversation://invalid)', existing)
    ).toBe(existing)
  })
})
