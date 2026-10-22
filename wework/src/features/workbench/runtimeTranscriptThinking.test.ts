import { describe, expect, test } from 'vitest'
import type { RuntimeTranscriptTurn } from '@wegent/chat-core/runtime'
import { runtimeTranscriptTurnsToConversationTurns } from './runtimePaneMessages'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from './runtimeConversationTurns'
import { getRuntimeMessageActiveThinking } from './runtimeThinking'

const summary = 'WEWORK_DESKTOP_E2E_REASONING_SUMMARY'

function heldToolTranscript(): RuntimeTranscriptTurn[] {
  return [
    {
      id: 'turn-held',
      status: 'streaming',
      items: [
        {
          id: 'reasoning-summary',
          type: 'block',
          block: {
            id: 'reasoning-summary',
            type: 'thinking',
            content: summary,
            status: 'done',
            timestamp: 1,
          },
        },
        {
          id: 'preamble',
          type: 'block',
          block: {
            id: 'preamble',
            type: 'text',
            content: 'I will inspect the command output.',
            status: 'done',
            timestamp: 2,
          },
        },
        {
          id: 'tool',
          type: 'block',
          block: {
            id: 'tool',
            type: 'tool',
            tool_name: 'exec_command',
            tool_input: { cmd: 'pwd' },
            status: 'done',
            timestamp: 3,
          },
        },
      ],
    },
  ]
}

describe('held native tool continuation thinking', () => {
  test('restores the summary when the native streaming turn hydrates a fresh conversation', () => {
    const snapshot = runtimeTranscriptTurnsToConversationTurns(heldToolTranscript())
    const turns = mergeRuntimeConversationTurns([], snapshot)
    const [message] = projectRuntimeConversationTurns(turns)

    expect(message.status).toBe('streaming')
    expect(message.blocks?.map(block => [block.type, block.status])).toEqual([
      ['thinking', 'done'],
      ['text', 'done'],
      ['tool', 'done'],
    ])
    expect(getRuntimeMessageActiveThinking(message)).toBe(summary)
  })

  test('restores the same summary when a local turn already exists', () => {
    const snapshot = runtimeTranscriptTurnsToConversationTurns(heldToolTranscript())
    const turns = mergeRuntimeConversationTurns(
      [{ id: 'turn-held', status: 'streaming', items: [] }],
      snapshot
    )
    const [message] = projectRuntimeConversationTurns(turns)

    expect(getRuntimeMessageActiveThinking(message)).toBe(summary)
  })

  test.each(['done', 'failed', 'cancelled'] as const)(
    'keeps a native %s turn free of active thinking',
    status => {
      const [nativeTurn] = heldToolTranscript()
      const snapshot = runtimeTranscriptTurnsToConversationTurns([{ ...nativeTurn, status }])
      const [message] = projectRuntimeConversationTurns(mergeRuntimeConversationTurns([], snapshot))

      expect(getRuntimeMessageActiveThinking(message)).toBe('')
      expect(message.streamingThinkingContent).toBeUndefined()
    }
  )

  test.each(['assistant_text', 'text'] as const)(
    'clears the held summary when native %s arrives after the tool',
    type => {
      const [nativeTurn] = heldToolTranscript()
      nativeTurn.items.push(
        type === 'assistant_text'
          ? { id: 'answer', type, content: 'The command completed.' }
          : {
              id: 'answer',
              type: 'block',
              block: {
                id: 'answer',
                type,
                content: 'The command completed.',
                status: 'done',
                timestamp: 4,
              },
            }
      )
      const snapshot = runtimeTranscriptTurnsToConversationTurns([nativeTurn])
      const [message] = projectRuntimeConversationTurns(mergeRuntimeConversationTurns([], snapshot))

      expect(getRuntimeMessageActiveThinking(message)).toBe('')
      expect(message.streamingThinkingContent).toBeUndefined()
    }
  )
})
