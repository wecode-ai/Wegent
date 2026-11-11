import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { GroupChatMessage } from './GroupChatMessage'

const message: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'message',
  projectId: 'group',
  sender: { type: 'user', id: '7', name: '林悦' },
  type: 'text',
  content: '这次讨论的结论',
  metadata: {},
  status: 'completed',
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
}

describe('Group chat sender identity and message sides', () => {
  it('places the current human on the right with a name and default avatar', () => {
    render(<GroupChatMessage message={message} currentUserId="7" focused={false} />)
    expect(screen.getByTestId('group-message-message')).toHaveAttribute('data-message-side', 'self')
    expect(screen.getByText('林悦（你）')).toBeVisible()
    expect(screen.getByTestId('group-message-avatar-message')).toHaveTextContent('林')
    expect(screen.getByText(message.content)).toBeVisible()
  })

  it.each(['8', '007'])('keeps another identity %s on the left even with the same name', id => {
    render(
      <GroupChatMessage
        message={{ ...message, sender: { ...message.sender, id } }}
        currentUserId="7"
        focused={false}
      />
    )
    expect(screen.getByTestId('group-message-message')).toHaveAttribute(
      'data-message-side',
      'other'
    )
    expect(screen.getByText('林悦')).toBeVisible()
    expect(screen.getByTestId('group-message-avatar-message')).toBeVisible()
  })

  it('keeps an agent on the left rather than treating its ID as the current human', () => {
    render(
      <GroupChatMessage
        message={{ ...message, sender: { ...message.sender, type: 'agent' } }}
        currentUserId="7"
        focused={true}
      />
    )
    expect(screen.getByTestId('group-message-message')).toHaveAttribute(
      'data-message-side',
      'other'
    )
    expect(screen.getByTestId('group-message-message')).toHaveAttribute('data-focused', 'true')
    expect(screen.getByTestId('group-message-avatar-message').querySelector('svg')).not.toBeNull()
  })

  it('centers a system event without impersonating a chat sender', () => {
    render(
      <GroupChatMessage
        message={{ ...message, sender: { ...message.sender, type: 'system' }, type: 'system' }}
        currentUserId="7"
        focused={false}
      />
    )
    expect(screen.getByTestId('group-message-message')).toHaveAttribute(
      'data-message-side',
      'system'
    )
    expect(screen.queryByTestId('group-message-avatar-message')).not.toBeInTheDocument()
    expect(screen.getByText(message.content)).toBeVisible()
  })
})
