// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { selectPrivateHistory } from './privateConversationHistory'

function turn(id: string, userId: string): RuntimeConversationTurn {
  return {
    id,
    clientUserMessageId: userId,
    status: 'done',
    items: [
      {
        id: userId,
        type: 'user_message',
        message: { id: userId, role: 'user', content: `${id} user text`, status: 'done' },
      },
      {
        id: `${id}-answer`,
        type: 'assistant_text',
        content: `${id} assistant text`,
        createdAt: '2026-11-03T00:00:00Z',
      },
    ],
  }
}

describe('private historical source boundaries', () => {
  it('shows only the authoritative native turn and never substitutes a newer source-id match', () => {
    const turns = [turn('old', 'old-user'), turn('new', 'new-user')]
    const result = selectPrivateHistory(turns, { turnId: 'old', userMessageIds: ['new-user'] })
    expect(result.turns.map(item => item.id)).toEqual(['old'])
    expect(JSON.stringify(result.messages)).not.toContain('new ')
    expect(
      selectPrivateHistory(turns, { turnId: 'missing', userMessageIds: ['new-user'] })
    ).toEqual({ available: false, turns: [], messages: [] })
  })

  it('uses exact native user/client identity when no turn id exists and denies absent or ambiguous provenance', () => {
    const turns = [turn('old', 'source-user'), turn('new', 'new-user')]
    expect(
      selectPrivateHistory(turns, { turnId: null, userMessageIds: ['source-user'] }).turns.map(
        item => item.id
      )
    ).toEqual(['old'])
    expect(
      selectPrivateHistory(turns, { turnId: null, userMessageIds: ['unknown'] }).available
    ).toBe(false)
    expect(
      selectPrivateHistory([...turns, turn('duplicate', 'source-user')], {
        turnId: null,
        userMessageIds: ['source-user'],
      }).available
    ).toBe(false)
  })

  it('includes continuations only through exact client identities accepted from the same pane', () => {
    const turns = [
      turn('old', 'source-user'),
      turn('unrelated', 'other-user'),
      turn('continuation', 'pane-accepted'),
    ]
    const result = selectPrivateHistory(turns, { turnId: 'old', userMessageIds: ['source-user'] }, [
      'pane-accepted',
    ])
    expect(result.turns.map(item => item.id)).toEqual(['old', 'continuation'])
    expect(JSON.stringify(result.messages)).not.toContain('unrelated')
    expect(turns).toHaveLength(3)
  })
})
