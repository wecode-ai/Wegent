import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { interactionQuestion, interactionTask } from './runtimeInteractions.fixtures'
import type { RuntimeInteraction } from './runtimeInteractions'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const viewport = vi.hoisted(() => ({ twoPanes: true }))
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => viewport.twoPanes }))
beforeEach(() => {
  viewport.twoPanes = true
})

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

function interactionValue(
  overrides: Partial<RuntimeInteractionsValue> = {}
): RuntimeInteractionsValue {
  return {
    pending: [approval],
    history: [],
    errors: {},
    drafts: {},
    busy: new Set(),
    loading: false,
    setDraft: vi.fn(),
    respond: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    notice: null,
    dismissNotice: vi.fn(),
    registerView: vi.fn(),
    ...overrides,
  }
}

function view(
  selectedId?: string,
  errors: Record<string, string> = {},
  overrides: Partial<RuntimeInteractionsValue> = {}
) {
  const value = interactionValue({ errors, ...overrides })
  render(
    <RuntimeInteractionsContext.Provider value={value}>
      <RuntimeInteractionsPage selectedId={selectedId} />
    </RuntimeInteractionsContext.Provider>
  )
  return value.registerView
}

it('routes native approvals to their original context without suggesting an ordinary reply', () => {
  view()
  expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
  expect(screen.queryByTestId('interaction-reply')).not.toBeInTheDocument()
  expect(screen.queryByText('interactions.resume_hint')).not.toBeInTheDocument()
})

it('shows available decision context initially and lets the user collapse it', () => {
  view()
  expect(screen.getByTestId('interaction-evidence-content')).toHaveTextContent('git status')
  expect(screen.getByTestId('interaction-evidence')).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByTestId('interaction-evidence'))
  expect(screen.queryByTestId('interaction-evidence-content')).not.toBeInTheDocument()
  expect(screen.getByTestId('interaction-evidence')).toHaveAttribute('aria-expanded', 'false')
})

it('does not offer an empty evidence disclosure or repeat the question as evidence', () => {
  view(undefined, {}, { pending: [{ ...approval, context: approval.question }] })
  expect(screen.queryByTestId('interaction-evidence')).not.toBeInTheDocument()
})

it('only registers a narrow-screen request as viewed after opening it and restores list focus', () => {
  viewport.twoPanes = false
  const registerView = view()
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), null)
  const row = screen.getByTestId('interaction-list-item')
  fireEvent.click(row)
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), approval.id)
  expect(screen.getByRole('heading', { name: approval.question })).toHaveFocus()
  fireEvent.click(screen.getByTestId('interactions-back-to-list'))
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), null)
  expect(row).toHaveFocus()
})

it('restores narrow-screen list heading focus when the handled request no longer has a row', () => {
  viewport.twoPanes = false
  const value = interactionValue()
  const page = (current: RuntimeInteractionsValue) => (
    <RuntimeInteractionsContext.Provider value={current}>
      <RuntimeInteractionsPage />
    </RuntimeInteractionsContext.Provider>
  )
  const { rerender } = render(page(value))
  fireEvent.click(screen.getByTestId('interaction-list-item'))
  expect(screen.getByRole('heading', { name: approval.question })).toHaveFocus()
  rerender(page({ ...value, pending: [] }))
  fireEvent.click(screen.getByTestId('interactions-back-to-list'))
  expect(screen.queryByTestId('interaction-list-item')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
  expect(value.registerView).toHaveBeenLastCalledWith(expect.any(String), null)
})

it('focuses a narrow-screen deep-linked question when its pending data arrives later', () => {
  viewport.twoPanes = false
  const value = interactionValue()
  const page = (current: RuntimeInteractionsValue | null) => (
    <RuntimeInteractionsContext.Provider value={current}>
      <RuntimeInteractionsPage selectedId={approval.id} />
    </RuntimeInteractionsContext.Provider>
  )
  const { rerender } = render(page(null))
  expect(screen.queryByRole('heading', { name: approval.question })).not.toBeInTheDocument()
  rerender(page(value))
  expect(screen.getByRole('heading', { name: approval.question })).toHaveFocus()
  expect(value.registerView).toHaveBeenLastCalledWith(expect.any(String), approval.id)
})

it('keeps a multiline page draft and submits Enter without submitting IME or Shift+Enter', () => {
  const respond = vi.fn()
  const request = {
    ...approval,
    id: 'question',
    question: 'Keep existing customer behavior?',
    context: 'Existing customers depend on the current rule.',
    payload: {
      ...interactionQuestion,
      questions: [{ ...interactionQuestion.questions![0], options: [] }],
    },
  }
  view(
    undefined,
    {},
    {
      pending: [request],
      drafts: { question: 'Keep the old rule.\nUse the new rule for new customers.' },
      respond,
    }
  )
  const input = screen.getByRole('textbox', { name: 'interactions.reply' })
  expect(input).toHaveValue('Keep the old rule.\nUse the new rule for new customers.')
  expect(input).not.toHaveFocus()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(respond).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    request,
    'Keep the old rule.\nUse the new rule for new customers.'
  )
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
