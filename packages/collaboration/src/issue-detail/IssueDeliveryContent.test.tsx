import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { SharedIssueDetailDeliveryDetail } from './createSharedIssueDetailPort'
import { IssueDeliveryContent } from './IssueDeliveryContent'

vi.mock('./IssueActivityMarkdown', () => ({
  IssueActivityMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}))

const delivery: SharedIssueDetailDeliveryDetail = {
  id: 'delivery-1',
  loop_item_id: 'issue-1',
  status: 'delivered',
  created_at: '2026-10-26T00:00:00Z',
  delivered_at: '2026-10-26T00:00:00Z',
  markdown: '',
  chat: null,
  assets: [],
  fulfillments: [],
}

function render(chat: SharedIssueDetailDeliveryDetail['chat'], markdown = '') {
  return renderToStaticMarkup(
    <IssueDeliveryContent
      delivery={{ ...delivery, chat, markdown }}
      translate={createCollaborationTranslator('zh-CN')}
    />
  )
}

describe('IssueDeliveryContent', () => {
  it('renders project-activity snapshots using their persisted sender fields', () => {
    const html = render({
      selection: { mode: 'all' },
      messages: [
        { sender: { type: 'user' }, content: 'Activity question' },
        { sender: { type: 'agent' }, content: 'Activity answer' },
      ],
    })
    expect(html).toContain('用户')
    expect(html).toContain('助手')
    expect(html.indexOf('Activity question')).toBeLessThan(html.indexOf('Activity answer'))
  })
  it.each(['conversation', 'selected'])('renders the %s snapshot in its stored order', scope => {
    const html = render({
      scope,
      messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
    })
    expect(html).toContain('交付会话')
    expect(html).toContain('用户')
    expect(html).toContain('助手')
    expect(html.indexOf('Question')).toBeLessThan(html.indexOf('Answer'))
  })

  it.each([null, {}, { messages: [] }, { messages: 'invalid' }])(
    'preserves description-only deliveries without a chat section: %j',
    chat => {
      const html = render(chat, 'Delivery notes')
      expect(html).toContain('Delivery notes')
      expect(html).not.toContain('todo-detail-delivery-chat')
    }
  )

  it('ignores malformed entries without losing valid snapshot messages', () => {
    const html = render({
      messages: [
        null,
        {},
        { role: 'user', content: 42 },
        { role: 'assistant', content: 'Stored result' },
      ],
    })
    expect(html).toContain('Stored result')
    expect(html).not.toContain('无交付说明')
  })
})
