import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { interactionTask } from './runtimeInteractions.fixtures'
import type { RuntimeInteraction } from './runtimeInteractions'
import { openWeworkScheme } from './schemeEvents'
import { QuestionDiscussionContext } from './questionDiscussion'
import type { PendingProjectIssue } from './usePendingProjectIssues'

const projectWork = vi.hoisted(() => ({
  items: [] as PendingProjectIssue[],
  errors: {} as Record<string, string>,
  loading: false,
  refresh: vi.fn(),
}))
vi.mock('./usePendingProjectIssues', () => ({ usePendingProjectIssues: () => projectWork }))

vi.mock('./schemeEvents', () => ({ openWeworkScheme: vi.fn() }))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const viewport = vi.hoisted(() => ({ twoPanes: true }))
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => viewport.twoPanes }))
beforeEach(() => {
  viewport.twoPanes = true
  projectWork.items = []
  projectWork.errors = {}
  projectWork.loading = false
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

it('opens discussion from pending-work details without answering or dismissing the question', () => {
  const open = vi.fn()
  const question: RuntimeInteraction = {
    ...approval,
    id: 'question',
    payload: {
      requestId: 42,
      questions: [{ id: 'audience', question: 'Who should receive it?' }],
    },
  }
  const value = interactionValue({ pending: [question] })
  render(
    <QuestionDiscussionContext.Provider value={{ open }}>
      <RuntimeInteractionsContext.Provider value={value}>
        <RuntimeInteractionsPage selectedId="question" />
      </RuntimeInteractionsContext.Provider>
    </QuestionDiscussionContext.Provider>
  )
  fireEvent.click(screen.getByTestId('interaction-discuss'))
  expect(open).toHaveBeenCalledWith(question.task.address, question.payload)
  expect(value.respond).not.toHaveBeenCalled()
  expect(value.dismiss).not.toHaveBeenCalled()
})

function interactionValue(
  overrides: Partial<RuntimeInteractionsValue> = {}
): RuntimeInteractionsValue {
  return {
    pending: [approval],
    history: [],
    errors: {},
    drafts: {},
    replyDrafts: [],
    busy: new Set(),
    loading: false,
    setDraft: vi.fn(),
    discardDraft: vi.fn().mockResolvedValue(true),
    respond: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    notice: null,
    dismissNotice: vi.fn(),
    dismiss: vi.fn(),
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

it('opens ordinary project work in the original Issue and reports the project count', () => {
  projectWork.items = [
    {
      item: {
        id: 'ISSUE-1',
        cloud_project_id: '12',
        project_name: 'Project',
        title: 'Please decide',
        status: 'pending',
        created_by_user_id: 0,
        created_at: '2026-11-08T00:00:00Z',
        updated_at: '2026-11-08T00:00:00Z',
      } as PendingProjectIssue['item'],
      store: 'local',
      userId: 0,
    },
  ]
  const reportProjectPendingCount = vi.fn()
  view(undefined, {}, { pending: [], reportProjectPendingCount })
  expect(screen.getByTestId('interaction-list-item')).toHaveAttribute('data-project-issue', 'true')
  expect(screen.getByTestId('test-original-entity')).toHaveTextContent(
    'wework://boards/local/12/issues/ISSUE-1'
  )
  expect(reportProjectPendingCount).toHaveBeenLastCalledWith(1)
})

it.each(['loading', 'error'] as const)(
  'does not publish a false zero while project work is %s',
  state => {
    projectWork.loading = state === 'loading'
    projectWork.errors = state === 'error' ? { backend: 'Offline' } : {}
    const reportProjectPendingCount = vi.fn()
    view(undefined, {}, { pending: [], reportProjectPendingCount })
    expect(reportProjectPendingCount).toHaveBeenLastCalledWith(null)
  }
)

vi.mock('./NotificationEntitySurface', () => ({
  NotificationEntitySurface: ({
    url,
    interactionId,
    onOriginalUrlChange,
  }: {
    url: string
    interactionId: string
    onOriginalUrlChange: (id: string, url: string) => void
  }) => (
    <div data-testid="test-original-entity">
      {url}
      <button
        data-testid="test-native-focus-resolved"
        onClick={() =>
          onOriginalUrlChange(
            interactionId,
            'wework://boards/local/12/issues/ISSUE-1/comments/native-ai'
          )
        }
      >
        Locate
      </button>
    </div>
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

it.each([true, false])(
  'recovers unsent text without reviving a handled question (desktop: %s)',
  async desktop => {
    viewport.twoPanes = desktop
    const discardDraft = vi.fn().mockResolvedValue(true)
    view(
      undefined,
      { [approval.id]: 'interactions.failed' },
      {
        pending: [],
        history: [],
        drafts: { [approval.id]: 'Unsent native reply', unrelated: 'Another task draft' },
        replyDrafts: [
          {
            text: 'Unsent native reply',
            nativeReplyIds: ['native-reply'],
            interaction: {
              id: approval.id,
              title: interactionTask.task.title,
              question: approval.question,
              address: interactionTask.address,
              answeredAt: Date.now(),
            },
          },
        ],
        discardDraft,
      }
    )
    expect(screen.getByTestId('interactions-pending-count')).toHaveTextContent('0')
    expect(screen.queryByTestId('interaction-list-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('test-original-entity')).not.toBeInTheDocument()
    const draft = screen.getByTestId('interaction-unsent-text')
    expect(draft).toHaveValue('Unsent native reply')
    expect(draft).toHaveAttribute('readonly')
    expect(screen.queryByText('Another task draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('interaction-discard-unsent'))
    await waitFor(() => expect(discardDraft).toHaveBeenCalledWith(approval.id))
  }
)

it('keeps unsent text visible and reports a failed discard', async () => {
  const discardDraft = vi.fn().mockResolvedValue(false)
  view(
    undefined,
    {},
    {
      pending: [],
      replyDrafts: [
        {
          text: 'Unsent native reply',
          nativeReplyIds: ['native-reply'],
          interaction: {
            id: approval.id,
            title: interactionTask.task.title,
            question: approval.question,
            address: interactionTask.address,
            answeredAt: Date.now(),
          },
        },
      ],
      discardDraft,
    }
  )

  fireEvent.click(screen.getByTestId('interaction-discard-unsent'))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'interactions.discard_unsent_reply_failed'
  )
  expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Unsent native reply')
})

it.each([true, false])('shows request time in the list and detail (desktop: %s)', desktop => {
  viewport.twoPanes = desktop
  const date = new Date()
  date.setHours(10, 24, 30, 0)
  view(approval.id, {}, { pending: [{ ...approval, createdAt: date.getTime() }] })
  const times = document.querySelectorAll('time')
  expect(times).toHaveLength(2)
  for (const time of times) {
    expect(time).toHaveAttribute('datetime', date.toISOString())
    expect(time).toHaveAttribute('title', date.toLocaleString())
    expect(time).toHaveTextContent(
      date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
  }
})

it('shows the handled time in history and its selected detail', () => {
  const date = new Date('2025-10-21T12:05:00Z')
  view(
    undefined,
    {},
    {
      pending: [],
      history: [
        {
          id: approval.id,
          title: interactionTask.task.title,
          question: approval.question,
          address: interactionTask.address,
          answeredAt: date.getTime(),
        },
      ],
    }
  )
  fireEvent.click(screen.getByTestId('interactions-history'))
  const times = document.querySelectorAll('time')
  expect(times).toHaveLength(2)
  for (const time of times) {
    expect(time).toHaveAttribute('datetime', date.toISOString())
    expect(time).toHaveAttribute('title', date.toLocaleString())
    expect(time).toHaveTextContent(
      date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      })
    )
  }
})

it.each([0, -1, NaN, Infinity, 1e20])(
  'omits unavailable or invalid request time: %s',
  createdAt => {
    view(approval.id, {}, { pending: [{ ...approval, createdAt }] })
    expect(document.querySelector('time')).not.toBeInTheDocument()
    expect(screen.getByTestId('interaction-question-heading')).toHaveTextContent(approval.question)
  }
)

it('groups pending questions by source type and orders each group newest first', () => {
  view(
    undefined,
    {},
    {
      pending: [
        { ...approval, id: 'older-task', question: 'Older task question', createdAt: 1 },
        {
          ...approval,
          id: 'project',
          question: 'Project question',
          source: 'project',
          createdAt: 4,
        },
        {
          ...approval,
          id: 'stand-in',
          question: 'Stand-in question',
          source: 'stand_in',
          createdAt: 5,
        },
        { ...approval, id: 'newer-task', question: 'Newer task question', createdAt: 3 },
      ],
    }
  )
  const tasks = within(screen.getByTestId('interaction-source-group-task'))
  expect(tasks.getAllByTestId('interaction-list-summary').map(row => row.textContent)).toEqual([
    'Newer task question',
    'Older task question',
  ])
  expect(tasks.getByTestId('interaction-source-count-task')).toHaveTextContent('2')
  expect(screen.getByTestId('interaction-source-group-project')).toHaveTextContent(
    'Project question'
  )
  expect(screen.getByTestId('interaction-source-group-stand_in')).toHaveTextContent(
    'Stand-in question'
  )
})

it('groups handled history and recognizes existing project destinations without source metadata', () => {
  view(
    undefined,
    {},
    {
      pending: [],
      history: [
        {
          id: 'project',
          title: 'Project',
          question: 'Project question',
          address: interactionTask.address,
          originalUrl: 'wework://boards/12/issues/issue',
          answeredAt: 1,
        },
        {
          id: 'stand-in',
          title: 'Stand-in',
          question: 'Stand-in question',
          address: interactionTask.address,
          source: 'stand_in',
          answeredAt: 2,
        },
      ],
    }
  )
  expect(screen.queryByTestId('interaction-source-group-task')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('interactions-history'))
  expect(screen.getByTestId('interaction-source-group-project')).toHaveTextContent(
    'Project question'
  )
  expect(screen.getByTestId('interaction-source-group-stand_in')).toHaveTextContent(
    'Stand-in question'
  )
  expect(screen.queryByTestId('interaction-source-group-task')).not.toBeInTheDocument()
})

it('dismisses a row without selecting or opening it', () => {
  const dismiss = vi.fn()
  view('another-request', {}, { dismiss })
  fireEvent.click(screen.getByTestId('interaction-dismiss'))
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(approval)
  expect(screen.getByTestId('interaction-list-item')).toHaveAttribute('aria-pressed', 'false')
})

it('disables dismissal during a response and hides it from handled history', () => {
  view(undefined, {}, { busy: new Set([approval.id]) })
  expect(screen.getByTestId('interaction-dismiss')).toBeDisabled()
  fireEvent.click(screen.getByTestId('interactions-history'))
  expect(screen.queryByTestId('interaction-dismiss')).not.toBeInTheDocument()
})

it('opens the original view at the AI message resolved inside the current entity', () => {
  vi.mocked(openWeworkScheme).mockClear()
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
  fireEvent.click(screen.getByTestId('test-native-focus-resolved'))
  fireEvent.click(screen.getByTestId('interaction-open-original'))
  expect(openWeworkScheme).toHaveBeenCalledExactlyOnceWith(
    'wework://boards/local/12/issues/ISSUE-1/comments/native-ai'
  )
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
  expect(screen.getByRole('heading', { name: approval.question })).toHaveFocus()
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

it.each(['task', 'issue'])(
  'keeps the original question visible in the %s detail when the narrow list is hidden',
  kind => {
    viewport.twoPanes = false
    const question = 'Original question\nwith the complete decision and no generated summary'
    const item = {
      ...approval,
      question,
      ...(kind === 'issue'
        ? {
            project: {
              projectId: 'project',
              issueId: 'issue',
              store: 'backend' as const,
              rootCommentId: 'root',
            },
          }
        : {}),
    }
    view(item.id, {}, { pending: [item] })
    const heading = screen.getByTestId('interaction-question-heading')
    expect(heading.textContent).toBe(question)
    expect(heading).toHaveFocus()
    expect(heading.closest('section')).not.toHaveClass('hidden')
    expect(screen.getByTestId('interaction-list-item').closest('section')).toHaveClass('hidden')
    expect(screen.getByTestId('interaction-open-original')).toBeVisible()
    expect(screen.getByTestId('test-original-entity')).toBeVisible()
  }
)

it('lets keyboard users enter the scrollable original question before opening the entity', async () => {
  const question = 'Original decision and relevant choices. '.repeat(30)
  view(approval.id, {}, { pending: [{ ...approval, question }] })
  screen.getByTestId('interaction-list-item').focus()
  await userEvent.tab()
  expect(screen.getByTestId('interaction-dismiss')).toHaveFocus()
  await userEvent.tab()
  expect(screen.getByTestId('interaction-question-heading')).toHaveFocus()
  expect(screen.getByTestId('interaction-question-heading').textContent).toBe(question)
  await userEvent.tab()
  expect(screen.getByTestId('interaction-open-original')).toHaveFocus()
})

it('keeps the close action available for shared Issue questions', () => {
  const shared = { ...approval, sharedRequest: { id: 'shared' } } as RuntimeInteraction
  const dismiss = vi.fn().mockResolvedValue(undefined)
  view(undefined, {}, { pending: [shared], dismiss })
  const close = screen.getByTestId('interaction-dismiss')
  expect(close).not.toHaveClass('md:opacity-0')
  fireEvent.click(close)
  expect(dismiss).toHaveBeenCalledWith(shared)
})

it('dismisses ordinary project work using its real Issue destination', async () => {
  projectWork.items = [
    {
      item: {
        id: 'ISSUE-1',
        cloud_project_id: '12',
        project_name: 'Project',
        title: 'Decide',
        updated_at: '2026-11-08T00:00:00Z',
        created_by_user_id: 0,
        status: 'pending',
      } as PendingProjectIssue['item'],
      store: 'local',
      userId: 0,
    },
  ]
  const dismiss = vi.fn().mockResolvedValue(undefined)
  view(undefined, {}, { pending: [], dismiss })
  fireEvent.click(screen.getByTestId('interaction-dismiss'))
  await waitFor(() =>
    expect(dismiss).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'project',
        originalUrl: 'wework://boards/local/12/issues/ISSUE-1',
        question: 'Decide',
      })
    )
  )
  expect(dismiss.mock.calls[0][0]).not.toHaveProperty('address')
})

it('dismisses a snapshot of all groups, continues after failure and reports it', async () => {
  const items = [
    approval,
    { ...approval, id: 'project', source: 'project' as const },
    { ...approval, id: 'stand-in', source: 'stand_in' as const },
  ]
  const dismiss = vi.fn().mockResolvedValue(undefined).mockRejectedValueOnce(new Error('Disk full'))
  view(undefined, {}, { pending: items, dismiss })
  fireEvent.click(screen.getByTestId('interactions-dismiss-all'))
  await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(3))
  expect(dismiss.mock.calls.map(([item]) => item.id)).toEqual(items.map(item => item.id))
  expect(screen.getByRole('alert')).toHaveTextContent('interactions.dismiss_failed')
})

it('prevents duplicate batch actions while archiving and re-enables after completion', async () => {
  let release!: () => void
  const dismiss = vi.fn(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      })
  )
  view(undefined, {}, { dismiss })
  fireEvent.click(screen.getByTestId('interactions-dismiss-all'))
  expect(screen.getByTestId('interactions-dismiss-all')).toBeDisabled()
  expect(screen.getByTestId('interaction-dismiss')).toBeDisabled()
  fireEvent.click(screen.getByTestId('interaction-dismiss'))
  expect(dismiss).toHaveBeenCalledTimes(1)
  release()
  await waitFor(() => expect(screen.getByTestId('interactions-dismiss-all')).toBeEnabled())
})

it('disables dismiss-all when empty or responding and hides it in history', () => {
  view(undefined, {}, { busy: new Set([approval.id]) })
  expect(screen.getByTestId('interactions-dismiss-all')).toBeDisabled()
  fireEvent.click(screen.getByTestId('interactions-history'))
  expect(screen.queryByTestId('interactions-dismiss-all')).not.toBeInTheDocument()
})

it('keeps a later project handoff visible after an earlier handoff was ignored', () => {
  projectWork.items = [
    {
      item: {
        id: 'ISSUE-1',
        cloud_project_id: '12',
        project_name: 'Project',
        title: 'New handoff',
        updated_at: '2026-11-09T00:00:00Z',
        created_by_user_id: 0,
        status: 'pending',
      } as PendingProjectIssue['item'],
      store: 'local',
      userId: 0,
    },
  ]
  view(undefined, {}, { pending: [], isDismissed: id => id.endsWith('2026-11-08T00:00:00Z') })
  expect(screen.getByTestId('interaction-list-item')).toHaveTextContent('New handoff')
})

it('does not count locally ignored project work', () => {
  projectWork.items = [
    {
      item: {
        id: 'ISSUE-1',
        cloud_project_id: '12',
        project_name: 'Project',
        title: 'Ignored',
        updated_at: '2026-11-08T00:00:00Z',
        created_by_user_id: 0,
        status: 'pending',
      } as PendingProjectIssue['item'],
      store: 'local',
      userId: 0,
    },
  ]
  const reportProjectPendingCount = vi.fn()
  view(undefined, {}, { pending: [], isDismissed: () => true, reportProjectPendingCount })
  expect(screen.queryByTestId('interaction-list-item')).not.toBeInTheDocument()
  expect(reportProjectPendingCount).toHaveBeenLastCalledWith(0)
  expect(screen.getByTestId('interactions-dismiss-all')).toBeDisabled()
})
