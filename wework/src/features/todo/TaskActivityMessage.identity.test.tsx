import { render, screen } from '@testing-library/react'
import { createCollaborationTranslator, IssueChatMessage } from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { describe, expect, it } from 'vitest'

const message: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'public-reply',
  projectId: 'project',
  taskId: 'issue',
  sender: { type: 'agent', id: 'stand-in:7:review', name: '助理' },
  type: 'text',
  content: '已完成检查',
  metadata: { stand_in: { user_id: 7, role_id: 'review' } },
  status: 'completed',
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
}

describe('Issue reply author identity', () => {
  it.each([false, true])('shows the owner and role with compact=%s', compact => {
    render(
      <IssueChatMessage
        message={message}
        members={[
          { user_id: 8, user_name: '其他用户' },
          { user_id: 7, user_name: '张三' },
        ]}
        mine={false}
        compact={compact}
        translate={createCollaborationTranslator('zh-CN')}
        onOpenUrl={() => {}}
      />
    )
    expect(screen.getByText('张三 (助理)')).toBeVisible()
    expect(screen.queryByText('其他用户 (助理)')).not.toBeInTheDocument()
  })

  it('keeps the owner identifiable when membership is unavailable, then resolves its name', () => {
    const props = {
      message,
      mine: false,
      translate: createCollaborationTranslator('zh-CN'),
      onOpenUrl: () => {},
    }
    const view = render(<IssueChatMessage {...props} />)
    expect(screen.getByText('#7 (助理)')).toBeVisible()
    view.rerender(<IssueChatMessage {...props} members={[{ user_id: 7, user_name: '张三' }]} />)
    expect(screen.getByText('张三 (助理)')).toBeVisible()
  })

  it.each(['agent', 'user'] as const)('preserves ordinary %s names', type => {
    render(
      <IssueChatMessage
        message={{ ...message, sender: { ...message.sender, type }, metadata: {} }}
        members={[{ user_id: 7, user_name: '张三' }]}
        mine={false}
        translate={createCollaborationTranslator('zh-CN')}
        onOpenUrl={() => {}}
      />
    )
    expect(screen.getByText('助理')).toBeVisible()
  })
})
