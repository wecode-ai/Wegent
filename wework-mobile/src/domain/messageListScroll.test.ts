import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types/runtime'
import { hasAppendedUserMessage } from './messageListScroll'

const reply: ChatMessage = {
  id: 'reply',
  role: 'assistant',
  content: 'Reply',
  status: 'completed',
  createdAt: 1,
}
const user: ChatMessage = {
  id: 'user',
  role: 'user',
  content: 'Follow up',
  status: 'completed',
  createdAt: 2,
}

describe('PC follow-up scroll contract', () => {
  it('follows new user messages after assistant-only history, including a batched reply', () => {
    expect(hasAppendedUserMessage([reply], [reply, user])).toBe(true)
    expect(hasAppendedUserMessage([reply], [reply, user, { ...reply, id: 'next' }])).toBe(true)
    expect(hasAppendedUserMessage([], [user])).toBe(true)
  })

  it('does not move the reader for pagination, streaming or replacement history', () => {
    expect(hasAppendedUserMessage([reply], [user, reply])).toBe(false)
    expect(hasAppendedUserMessage([reply], [{ ...reply, content: 'More text' }])).toBe(false)
    expect(hasAppendedUserMessage([reply], [user, { ...reply, id: 'other-task' }])).toBe(false)
  })
})
