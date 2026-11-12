import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { GroupChatMessage } from './GroupChatMessage'
import { createGroupReplyTarget } from './groupReply'

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

  it('offers a keyboard-focusable reply only when the host supplies write authority', () => {
    const reply = vi.fn()
    const view = render(
      <GroupChatMessage message={message} currentUserId="7" focused={false} onReply={reply} />
    )
    const action = screen.getByRole('button', { name: '回复' })
    action.focus()
    expect(action).toHaveFocus()
    fireEvent.click(action)
    expect(reply).toHaveBeenCalledWith(message)
    view.rerender(<GroupChatMessage message={message} currentUserId="7" focused={false} />)
    expect(screen.queryByRole('button', { name: '回复' })).not.toBeInTheDocument()
  })

  it.each([
    { ...message, type: 'system' as const },
    { ...message, sender: { ...message.sender, type: 'system' as const } },
    { ...message, content: '' },
  ])('does not invent reply actions for a system or unreadable message', value => {
    render(<GroupChatMessage message={value} currentUserId="7" focused={false} onReply={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '回复' })).not.toBeInTheDocument()
  })

  it('renders the stored reply relationship and scoped quote separately from the plain body', () => {
    const original = { ...message, messageId: 'original', content: '原讨论' }
    render(
      <GroupChatMessage
        message={{ ...message, content: '@成员', replyToMessageId: 'original' }}
        currentUserId="7"
        focused={false}
        scopeKey="owner"
        replyTo={createGroupReplyTarget('owner', original)}
      />
    )
    expect(screen.getByTestId('group-message-message')).toHaveAttribute(
      'data-reply-to-message-id',
      'original'
    )
    expect(screen.getByTestId('group-message-quoted-message')).toHaveTextContent('原讨论')
    expect(screen.getByTestId('group-message-content-message')).toHaveTextContent(/^@成员$/)
  })

  it.each(['old-account', 'different-thread'])('does not reveal a quote from %s', scopeKey => {
    render(
      <GroupChatMessage
        message={{ ...message, replyToMessageId: 'original' }}
        currentUserId="7"
        focused={false}
        scopeKey="current"
        replyTo={{
          scopeKey,
          messageId: 'original',
          senderName: 'Other account',
          content: 'Private old quote',
        }}
      />
    )
    expect(screen.queryByText('Private old quote')).not.toBeInTheDocument()
    expect(screen.getByTestId('group-message-quoted-message')).toHaveTextContent(
      '这条消息已删除或无法查看'
    )
  })
})
