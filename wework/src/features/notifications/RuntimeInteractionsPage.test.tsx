import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { interactionTask } from './runtimeInteractions.fixtures'
import type { RuntimeInteraction } from './runtimeInteractions'
import { openWeworkScheme } from './schemeEvents'

vi.mock('./schemeEvents', () => ({ openWeworkScheme: vi.fn() }))

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

vi.mock('./NotificationEntitySurface', () => ({
  NotificationEntitySurface: ({ url }: { url: string }) => (
    <div data-testid="test-original-entity">{url}</div>
  ),
}))

it('hosts the original entity instead of building a separate approval or reply form', () => {
  view()
  expect(screen.getByTestId('test-original-entity')).toHaveTextContent(
    'wework://tasks/device/review'
  )
  expect(screen.queryByTestId('interaction-reply')).not.toBeInTheDocument()
  expect(screen.queryByTestId('interaction-evidence')).not.toBeInTheDocument()
})

it('hosts an Issue destination including its owning comment', () => {
  view(
    undefined,
    {},
    {
      pending: [
        {
          ...approval,
          project: { projectId: '12', issueId: 'ISSUE-1', rootCommentId: 'root', store: 'local' },
        },
      ],
    }
  )
  expect(screen.getByTestId('test-original-entity')).toHaveTextContent(
    'wework://boards/local/12/issues/ISSUE-1/comments/root'
  )
})

it.each(['local', 'backend'] as const)(
  'opens the original %s Issue at its owning comment from the container header',
  store => {
    vi.mocked(openWeworkScheme).mockClear()
    view(
      undefined,
      {},
      {
        pending: [
          {
            ...approval,
            project: {
              projectId: '12',
              issueId: 'ISSUE-1',
              rootCommentId: 'root',
              store,
            },
          },
        ],
      }
    )
    fireEvent.click(screen.getByTestId('interaction-open-original'))
    expect(openWeworkScheme).toHaveBeenCalledExactlyOnceWith(
      `wework://boards/${store === 'local' ? 'local/' : ''}12/issues/ISSUE-1/comments/root`
    )
  }
)

it('opens the exact original task from the container header', () => {
  vi.mocked(openWeworkScheme).mockClear()
  view()
  fireEvent.click(screen.getByTestId('interaction-open-original'))
  expect(openWeworkScheme).toHaveBeenCalledExactlyOnceWith('wework://tasks/device/review')
})

it('only registers a narrow-screen request as viewed after opening it and restores list focus', () => {
  viewport.twoPanes = false
  const registerView = view()
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), null)
  const row = screen.getByTestId('interaction-list-item')
  fireEvent.click(row)
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), approval.id)
  expect(screen.getByRole('heading', { name: approval.task.task.title })).toHaveFocus()
  fireEvent.click(screen.getByTestId('interactions-back-to-list'))
  expect(registerView).toHaveBeenLastCalledWith(expect.any(String), null)
  expect(row).toHaveFocus()
})

it('keeps the displayed detail open when resizing a desktop inbox to a narrow window', () => {
  const value = interactionValue()
  const page = (
    <RuntimeInteractionsContext.Provider value={value}>
      <RuntimeInteractionsPage />
    </RuntimeInteractionsContext.Provider>
  )
  const { rerender } = render(page)
  viewport.twoPanes = false
  rerender(
    <RuntimeInteractionsContext.Provider value={value}>
      <RuntimeInteractionsPage />
    </RuntimeInteractionsContext.Provider>
  )
  const back = screen.getByTestId('interactions-back-to-list')
  expect(back.closest('section')).not.toHaveClass('hidden')
  expect(value.registerView).toHaveBeenLastCalledWith(expect.any(String), approval.id)
  fireEvent.click(back)
  expect(screen.getByTestId('interaction-list-item').closest('section')).not.toHaveClass('hidden')
  expect(value.registerView).toHaveBeenLastCalledWith(expect.any(String), null)
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
  expect(screen.getByRole('heading', { name: approval.task.task.title })).toHaveFocus()
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
  expect(screen.queryByRole('heading', { name: approval.task.task.title })).not.toBeInTheDocument()
  rerender(page(value))
  expect(screen.getByRole('heading', { name: approval.task.task.title })).toHaveFocus()
  expect(value.registerView).toHaveBeenLastCalledWith(expect.any(String), approval.id)
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
