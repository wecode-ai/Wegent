import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeInteractionNotice } from './RuntimeInteractionNotice'
import { RuntimeInteractionsContext } from './RuntimeInteractionsContext'
import { issueHumanInteraction } from './issueHumanInteractions'
import { interactionOriginalScheme, type RuntimeInteraction } from './runtimeInteractions'
import { WEWORK_OPEN_SCHEME_EVENT } from './schemeEvents'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const assigned = issueHumanInteraction(
  {
    id: 'question',
    project_id: '12',
    issue_id: 'issue',
    root_comment_id: 'root',
    runtime_device_id: 'device',
    runtime_task_id: 'task',
    item_id: 'native-question',
    question: 'Which scope?',
    recipient_user_id: 7,
    recipient_name: 'Recipient',
    blocks_progress: true,
    status: 'pending',
    version: 1,
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z',
  },
  'backend'
)

function show(item: RuntimeInteraction) {
  const respond = vi.fn()
  render(
    <RuntimeInteractionsContext.Provider
      value={{
        notice: item,
        pending: [item],
        history: [],
        errors: {},
        drafts: {},
        replyDrafts: [],
        busy: new Set(),
        loading: false,
        setDraft: vi.fn(),
        respond,
        dismiss: vi.fn(),
        refresh: vi.fn(),
        open: vi.fn(),
        dismissNotice: vi.fn(),
        registerView: vi.fn(),
      }}
    >
      <RuntimeInteractionNotice />
    </RuntimeInteractionsContext.Provider>
  )
  return respond
}

describe('reminder action authority', () => {
  it('shows the question creation time with the complete timestamp available', () => {
    const date = new Date()
    date.setHours(9, 5, 0, 0)
    show({ ...assigned, createdAt: date.getTime() })
    const time = screen.getByTestId('interaction-notice-time')
    expect(time).toHaveTextContent(
      date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
    expect(time).toHaveAttribute('datetime', date.toISOString())
    expect(time).toHaveAttribute('title', date.toLocaleString())
  })

  it('shows the date for an older question', () => {
    const date = new Date('2020-01-02T09:05:00Z')
    show({ ...assigned, createdAt: date.getTime() })
    expect(screen.getByTestId('interaction-notice-time')).toHaveTextContent(
      date.toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
    )
  })

  it.each([0, -1, NaN, Infinity, 1e20])('omits invalid creation time %s', createdAt => {
    show({ ...assigned, createdAt })
    expect(screen.queryByTestId('interaction-notice-time')).not.toBeInTheDocument()
    expect(screen.getByTestId('interaction-notice-reply')).toBeInTheDocument()
  })

  it('offers the reply disclosure only when the assigned question can be answered', () => {
    show(assigned)
    expect(screen.queryByTestId('interaction-open-original-action')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('interaction-notice-reply'))
    expect(screen.getByTestId('interaction-reply')).toBeInTheDocument()
  })

  it.each([
    [
      'unassigned',
      { ...assigned, sharedRequest: { ...assigned.sharedRequest!, recipient_user_id: null } },
    ],
    ['cached', { ...assigned, cached: true }],
    [
      'approval',
      { ...assigned, payload: { ...assigned.payload, interactionKind: 'approval' as const } },
    ],
    [
      'other recipient',
      { ...assigned, sharedRequest: { ...assigned.sharedRequest!, can_reply: false } },
    ],
  ])(
    'opens the original context directly for %s work without promising a reply',
    (_state, item) => {
      const respond = show(item)
      const opened = vi.fn()
      window.addEventListener(WEWORK_OPEN_SCHEME_EVENT, opened)
      try {
        expect(screen.queryByTestId('interaction-notice-reply')).not.toBeInTheDocument()
        expect(screen.queryByTestId('interaction-reply-input')).not.toBeInTheDocument()
        const action = screen.getByTestId('interaction-open-original-action')
        expect(action).toHaveTextContent('interactions.open_original')
        fireEvent.click(action)
        expect(opened).toHaveBeenCalledWith(
          expect.objectContaining({ detail: interactionOriginalScheme(item) })
        )
        expect(respond).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener(WEWORK_OPEN_SCHEME_EVENT, opened)
      }
    }
  )
})
