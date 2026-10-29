import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { interactionTask } from './runtimeInteractions.fixtures'
import type { RuntimeInteraction } from './runtimeInteractions'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const approval: RuntimeInteraction = {
  id: 'approval',
  requestKey: 'request:41',
  task: interactionTask,
  question: 'Allow this command? git status',
  context: 'git status',
  createdAt: 0,
  payload: {
    kind: 'request_user_input',
    requestId: 41,
    interactionKind: 'approval',
    approvalKind: 'command',
    command: 'git status',
  },
  answered: false,
}

function view(selectedId?: string, errors: Record<string, string> = {}) {
  const registerView = vi.fn()
  const value: RuntimeInteractionsValue = {
    pending: [approval],
    history: [],
    errors,
    drafts: {},
    busy: new Set(),
    loading: false,
    setDraft: vi.fn(),
    respond: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    notice: null,
    dismissNotice: vi.fn(),
    registerView,
  }
  render(
    <RuntimeInteractionsContext.Provider value={value}>
      <RuntimeInteractionsPage selectedId={selectedId} />
    </RuntimeInteractionsContext.Provider>
  )
  return registerView
}

it('routes native approvals to their original context without suggesting an ordinary reply', () => {
  view()
  expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
  expect(screen.queryByTestId('interaction-reply')).not.toBeInTheDocument()
  expect(screen.queryByText('interactions.resume_hint')).not.toBeInTheDocument()
})

it('shows an expired exact destination without selecting or suppressing an unrelated request', () => {
  const registerView = view('expired-request')
  expect(screen.getByText('interactions.expired')).toBeInTheDocument()
  expect(screen.queryByTestId('interaction-open-original-action')).not.toBeInTheDocument()
  expect(screen.getByTestId('interaction-list-item')).toHaveAttribute('aria-pressed', 'false')
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), null)
})

it.each(['interactions.load_failed', 'interactions.failed', 'interactions.expired'])(
  'shows an orphaned %s error exactly once without relabeling it',
  error => {
    view(undefined, { 'old-request': error })
    expect(screen.getByRole('alert')).toHaveTextContent(new RegExp('^' + error + '$'))
  }
)
