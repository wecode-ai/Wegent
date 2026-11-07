import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useContext, useEffect, useRef, useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { QuestionDiscussionProvider } from './QuestionDiscussionProvider'
import { QuestionDiscussionScope } from './QuestionDiscussionScope'
import {
  canDiscussQuestion,
  questionDiscussionDrafts,
  questionDiscussionKey,
  QuestionDiscussionStoreContext,
  useQuestionDiscussion,
  type QuestionDiscussionStore,
} from './questionDiscussion'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { WorkbenchPaneContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import { pendingRequestUserInputPayload } from '@/components/layout/requestUserInputOverlay'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import type { WorkbenchMessage } from '@/types/workbench'

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  selectedText: '仅自己，可以保留草稿',
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: {
    autoSubmitInitialInput?: boolean
    initialInput: string
    initialAddress?: unknown
    draft?: { value: string; onChange(value: string): void }
    controlledAddress?: unknown
    createTask: (message: string, options: object) => Promise<unknown>
    onAddressChange: (address: unknown) => void
    onFillSelectionToAnswer?: (text: string) => void
  }) => {
    const started = useRef(false)
    const [localInput, setLocalInput] = useState(props.initialInput)
    const input = props.draft?.value ?? localInput
    const setInput = props.draft?.onChange ?? setLocalInput
    const [error, setError] = useState<string | null>(null)
    const send = () => {
      if (started.current || props.initialAddress) return
      started.current = true
      void props.createTask(input, { onError: setError }).then(address => {
        if (address) props.onAddressChange(address)
      })
    }
    return (
      <div data-testid="discussion-test-conversation">
        <input
          data-testid="discussion-test-draft"
          value={input}
          onChange={event => setInput(event.target.value)}
        />
        <button data-testid="discussion-test-send" onClick={send}>
          Send discussion
        </button>
        <button
          data-testid="discussion-test-fill"
          onClick={() => props.onFillSelectionToAnswer?.(mock.selectedText)}
        >
          Fill selected text
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    )
  },
}))

const source = { deviceId: 'device', taskId: 'source' }
const side = { deviceId: 'device', taskId: 'side' }
const payload: RequestUserInputPayload = {
  kind: 'request_user_input',
  requestId: 12,
  questions: [
    {
      id: 'audience',
      question: '谁可以查看报告？',
      options: [{ label: '仅自己' }, { label: '所有人' }],
    },
  ],
}
const originalMessage = (input = payload): WorkbenchMessage => ({
  id: 'original',
  role: 'assistant',
  content: '',
  status: 'done',
  createdAt: '',
  blocks: [
    {
      id: 'question',
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      renderPayload: input,
    },
  ],
})
const submit = vi.fn()
const cancel = vi.fn()
let latestStore: QuestionDiscussionStore
function StoreProbe() {
  const store = useContext(QuestionDiscussionStoreContext)!
  const discussion = useQuestionDiscussion()
  useEffect(() => {
    latestStore = store
  }, [store])
  return (
    <button data-testid="open-another-panel" onClick={() => discussion?.close()}>
      Open another panel
    </button>
  )
}
function setup(count = 1, input = payload) {
  return render(
    <QuestionDiscussionProvider>
      {Array.from({ length: count }, (_, index) => (
        <WorkbenchPaneContext.Provider
          key={index}
          value={
            {
              createTemporaryRuntimeTask: mock.create,
              loadRuntimeTranscriptForPane: mock.load,
            } as unknown as WorkbenchPaneContextValue
          }
        >
          <QuestionDiscussionScope>
            <StoreProbe />
            <section data-testid={`entry-${index}`}>
              <RequestUserInputCard
                payload={input}
                source={source}
                onSubmit={submit}
                onIgnore={cancel}
              />
            </section>
          </QuestionDiscussionScope>
        </WorkbenchPaneContext.Provider>
      ))}
    </QuestionDiscussionProvider>
  )
}
const showSidebar = (index = 0) =>
  fireEvent.click(
    within(screen.getByTestId(`entry-${index}`)).getByTestId('request-user-input-discuss')
  )
const dialog = () => screen.getByRole('region')
const open = (index = 0) => {
  showSidebar(index)
  fireEvent.click(within(dialog()).getByTestId('discussion-test-send'))
}
const changeConclusion = (text = '仅自己，可以保留草稿') => {
  mock.selectedText = text
}
const apply = () => fireEvent.click(within(dialog()).getByTestId('discussion-test-fill'))

beforeEach(() => {
  vi.clearAllMocks()
  mock.selectedText = '仅自己，可以保留草稿'
  mock.create.mockResolvedValue(side)
  mock.load.mockResolvedValue({ messages: [originalMessage()], turns: [] })
  submit.mockResolvedValue(true)
})

test('discusses independently, preserves defaults, fills an editable draft and submits only after review', async () => {
  setup()
  showSidebar()
  expect(mock.create).not.toHaveBeenCalled()
  expect(
    (within(dialog()).getByTestId('discussion-test-draft') as HTMLInputElement).value
  ).toContain('谁可以查看报告？')
  fireEvent.click(within(dialog()).getByTestId('discussion-test-send'))
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1))
  expect(mock.create).toHaveBeenCalledWith(
    expect.stringContaining('谁可以查看报告？'),
    expect.objectContaining({ source, project: null })
  )
  expect(submit).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('question-discussion-sidebar')).toContainElement(dialog())
  expect(within(dialog()).getByTestId('discussion-test-conversation')).not.toHaveTextContent(
    'requestId'
  )
  changeConclusion()
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  const answer = screen.getByTestId('request-user-input-custom-audience')
  expect(answer).toHaveValue('仅自己，可以保留草稿')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(answer, { target: { value: '仅自己，确认后发布' } })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 12,
        answers: { audience: { answers: ['仅自己，确认后发布'] } },
      })
    )
  )
})

test('closing and reopening preserves the edited prompt without sending or cancelling', async () => {
  setup()
  showSidebar()
  const draft = within(dialog()).getByTestId('discussion-test-draft')
  fireEvent.change(draft, { target: { value: '先讨论敏感事项，不要直接发布。' } })
  fireEvent.keyDown(dialog(), { key: 'Escape' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  showSidebar()
  expect(within(dialog()).getByTestId('discussion-test-draft')).toBe(draft)
  expect(draft).toHaveValue('先讨论敏感事项，不要直接发布。')
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(within(dialog()).getByTestId('discussion-test-send'))
  await waitFor(() =>
    expect(mock.create).toHaveBeenCalledExactlyOnceWith(
      '先讨论敏感事项，不要直接发布。',
      expect.objectContaining({ source, project: null })
    )
  )
  expect(cancel).not.toHaveBeenCalled()
})

test('opening another panel preserves discussion input without restoring focus to the old opener', () => {
  setup()
  showSidebar()
  const draft = within(dialog()).getByTestId('discussion-test-draft')
  fireEvent.change(draft, { target: { value: '继续讨论接收范围。' } })
  const navigate = screen.getByTestId('open-another-panel')
  navigate.focus()
  fireEvent.click(navigate)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(navigate).toHaveFocus()
  showSidebar()
  expect(within(dialog()).getByTestId('discussion-test-draft')).toBe(draft)
  expect(draft).toHaveValue('继续讨论接收范围。')
  expect(mock.create).not.toHaveBeenCalled()
})

test('shares edited unsent prompts between the task and pending-work entry points', () => {
  setup(2)
  showSidebar(0)
  fireEvent.change(within(dialog()).getByTestId('discussion-test-draft'), {
    target: { value: '请只讨论，先别发送。' },
  })
  fireEvent.click(within(dialog()).getByTestId('question-discussion-close'))
  showSidebar(1)
  expect(within(dialog()).getByTestId('discussion-test-draft')).toHaveValue('请只讨论，先别发送。')
  expect(mock.create).not.toHaveBeenCalled()
})

test('moves keyboard focus into the sidebar without a modal and restores it on Escape', () => {
  setup()
  const trigger = screen.getByTestId('request-user-input-discuss')
  trigger.focus()
  fireEvent.click(trigger)
  expect(dialog()).toHaveFocus()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

test('both entry surfaces share an in-flight creation and the returned answer', async () => {
  let resolve!: (value: typeof side) => void
  mock.create.mockReturnValue(
    new Promise(value => {
      resolve = value
    })
  )
  setup(2)
  open(0)
  fireEvent.click(within(dialog()).getByTestId('question-discussion-close'))
  open(1)
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1))
  await act(async () => resolve(side))
  changeConclusion('同一份结论')
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  for (const answer of screen.getAllByTestId('request-user-input-custom-audience'))
    expect(answer).toHaveValue('同一份结论')
})

test('fills only the text selected by the user and keeps the original answer editable', async () => {
  setup()
  open()
  changeConclusion('完整建议中的一小段')
  expect(screen.queryByTestId('question-discussion-conclusion')).not.toBeInTheDocument()
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('完整建议中的一小段')
  expect(submit).not.toHaveBeenCalled()
})

test.each(['answered', 'cancelled', 'expired'] as const)(
  'refuses a %s original request without losing the discussion',
  async interactionStatus => {
    mock.load.mockResolvedValue({
      messages: [originalMessage({ ...payload, interactionStatus })],
      turns: [],
    })
    setup()
    open()
    changeConclusion()
    apply()
    await waitFor(() =>
      expect(within(dialog()).getByRole('alert')).toHaveTextContent('原问题已处理或已失效')
    )
    expect(mock.selectedText).toBe('仅自己，可以保留草稿')
    expect(submit).not.toHaveBeenCalled()
  }
)

test('retains a conclusion after validation failure and allows retry', async () => {
  mock.load.mockRejectedValueOnce(new Error('offline'))
  setup()
  open()
  changeConclusion()
  apply()
  await waitFor(() =>
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('暂时无法检查原问题')
  )
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue(
    '仅自己，可以保留草稿'
  )
})

test('rejects incomplete paginated history instead of reviving an older question', async () => {
  mock.load.mockResolvedValue({
    messages: [originalMessage()],
    turns: [],
    hasMoreBefore: true,
    beforeCursor: null,
  })
  setup()
  open()
  changeConclusion()
  apply()
  await waitFor(() =>
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('暂时无法检查原问题')
  )
  expect(submit).not.toHaveBeenCalled()
})

test('keeps grouped asynchronous drafts bound to their individual original requests', () => {
  const first = { ...payload, delivery: 'async' }
  const second = {
    ...first,
    requestId: 13,
    questions: [{ id: 'audience', question: '输出格式？' }],
  }
  const grouped = pendingRequestUserInputPayload([originalMessage(first), originalMessage(second)])!
  const sessions = Object.fromEntries(
    [first, second].map((input, index) => [
      questionDiscussionKey(source, input),
      {
        source,
        payload: input,
        address: null,
        answers: { audience: index ? 'PDF' : '仅自己' },
      },
    ])
  )
  const drafts = questionDiscussionDrafts(sessions, source, grouped)
  expect(Object.values(drafts)).toEqual(['仅自己', 'PDF'])
  expect(questionDiscussionDrafts(sessions, { ...source, taskId: 'other-task' }, grouped)).toEqual(
    {}
  )
})

test('editing an individual answer cannot replace a grouped discussion payload', () => {
  const first = { ...payload, delivery: 'async' }
  const second = {
    ...first,
    requestId: 13,
    questions: [{ id: 'audience', question: '输出格式？' }],
  }
  const grouped = pendingRequestUserInputPayload([originalMessage(first), originalMessage(second)])!
  expect(questionDiscussionKey(source, grouped)).not.toBe(questionDiscussionKey(source, first))
  setup(1, grouped)
  open()
  fireEvent.change(
    within(screen.getByTestId('entry-0')).getByTestId('request-user-input-custom-audience'),
    { target: { value: 'Only the owner' } }
  )
  expect(
    within(dialog()).getByTestId('question-discussion-question').querySelectorAll('option')
  ).toHaveLength(2)
  expect(
    latestStore.sessions[questionDiscussionKey(source, grouped)].payload.questions
  ).toHaveLength(2)
})

test('immediately falls back to an available target when a selected question disappears', async () => {
  const multi = {
    ...payload,
    questions: [...payload.questions!, { id: 'format', question: '输出格式？', is_other: true }],
  }
  setup(1, multi)
  open()
  fireEvent.change(within(dialog()).getByTestId('question-discussion-question'), {
    target: { value: 'format' },
  })
  fireEvent.change(
    within(screen.getByTestId('entry-0')).getByTestId('request-user-input-custom-format'),
    { target: { value: 'Keep this draft' } }
  )
  act(() =>
    latestStore.update(questionDiscussionKey(source, multi), current => ({ ...current!, payload }))
  )
  changeConclusion('Available target only')
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue(
    'Available target only'
  )
  expect(screen.getByTestId('request-user-input-custom-format')).toHaveValue('Keep this draft')
})

test('business discussion cannot replace native permission or connector authorization', () => {
  expect(canDiscussQuestion(payload)).toBe(true)
  expect(
    canDiscussQuestion({
      ...payload,
      questions: [{ id: 'mcp_tool_call_approval_native', question: 'Allow?' }],
    })
  ).toBe(false)
  for (const override of [
    { approvalKind: 'command' },
    { interactionKind: 'mcp_form' },
    { interactionKind: 'mcp_url' },
    { serverName: 'connector' },
    { expiresAtUnixMs: 1 },
  ]) {
    expect(canDiscussQuestion({ ...payload, ...override })).toBe(false)
  }
})

test('does not refill an asynchronous question already answered on a newer history page', async () => {
  const asyncPayload = { ...payload, delivery: 'async' }
  mock.load
    .mockResolvedValueOnce({
      messages: [
        { id: 'answer', role: 'user', status: 'done', content: '项目成员', createdAt: '' },
      ],
      turns: [],
      hasMoreBefore: true,
      beforeCursor: 'older',
    })
    .mockResolvedValueOnce({
      messages: [originalMessage(asyncPayload)],
      turns: [],
      hasMoreBefore: false,
    })
  setup(1, asyncPayload)
  open()
  changeConclusion()
  apply()
  await waitFor(() =>
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('原问题已处理或已失效')
  )
  expect(mock.load).toHaveBeenCalledTimes(2)
  expect(submit).not.toHaveBeenCalled()
})

test('refills the exact owner of a grouped asynchronous question', async () => {
  const first = { ...payload, delivery: 'async' }
  const second = {
    ...first,
    requestId: 13,
    questions: [{ id: 'audience', question: '输出格式？' }],
  }
  const grouped = pendingRequestUserInputPayload([originalMessage(first), originalMessage(second)])!
  mock.load.mockResolvedValue({
    messages: [originalMessage(first), originalMessage(second)],
    turns: [],
  })
  setup(1, grouped)
  open()
  const secondId = grouped.questions![1].id!
  fireEvent.change(within(dialog()).getByTestId('question-discussion-question'), {
    target: { value: secondId },
  })
  changeConclusion('PDF')
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId(`request-user-input-custom-${secondId}`)).toHaveValue('PDF')
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('仅自己')
})

test('does not revive an errored native question block', async () => {
  const message = originalMessage()
  message.blocks![0] = { ...message.blocks![0], status: 'error' }
  mock.load.mockResolvedValue({ messages: [message], turns: [] })
  setup()
  open()
  changeConclusion()
  apply()
  await waitFor(() =>
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('原问题已处理或已失效')
  )
  expect(submit).not.toHaveBeenCalled()
})

test('returns a plan adjustment without approving implementation', async () => {
  const message: WorkbenchMessage = {
    id: 'plan-message',
    role: 'assistant',
    status: 'done',
    content: '',
    createdAt: '',
    blocks: [{ type: 'plan', id: 'plan', status: 'done', content: '先调查数据，再修改代码。' }],
  }
  const plan = pendingRequestUserInputPayload([message])!
  mock.load.mockResolvedValue({ messages: [message], turns: [] })
  setup(1, plan)
  open()
  expect(screen.queryByTestId('request-user-input-custom-implement')).not.toBeInTheDocument()
  expect(within(dialog()).queryByTestId('question-discussion-question')).not.toBeInTheDocument()
  changeConclusion('请先补充数据来源，再开始实施。')
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId('request-user-input-custom-adjustment')).toHaveValue(
    '请先补充数据来源，再开始实施。'
  )
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { adjustment: { answers: ['请先补充数据来源，再开始实施。'] } },
      })
    )
  )
})

test('a shared creation failure is visible in the currently open entry surface', async () => {
  let resolve!: (result: false) => void
  mock.create.mockReturnValue(
    new Promise(value => {
      resolve = value
    })
  )
  setup(2)
  open(0)
  fireEvent.click(within(dialog()).getByTestId('question-discussion-close'))
  open(1)
  await act(async () => resolve(false))
  await waitFor(() =>
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('讨论暂时未能开始')
  )
  expect(mock.create).toHaveBeenCalledTimes(1)
})

test('account switches isolate discussion drafts and late creation without remounting unrelated input', async () => {
  let store!: QuestionDiscussionStore
  function Probe() {
    const current = useContext(QuestionDiscussionStoreContext)!
    useEffect(() => {
      store = current
    }, [current])
    return <input aria-label="Keep connection input" defaultValue="" />
  }
  const tree = (accountKey: string) => (
    <QuestionDiscussionProvider accountKey={accountKey}>
      <Probe />
    </QuestionDiscussionProvider>
  )
  const rendered = render(tree('account-a'))
  const key = questionDiscussionKey(source, payload)
  fireEvent.change(screen.getByRole('textbox', { name: 'Keep connection input' }), {
    target: { value: 'connection draft' },
  })
  act(() =>
    store.update(key, () => ({
      source,
      payload,
      address: null,
      answers: { audience: 'private answer' },
    }))
  )
  const oldStore = store
  let resolve!: (value: typeof side) => void
  let pending!: Promise<unknown>
  act(() => {
    pending = oldStore.create(
      key,
      () =>
        new Promise(value => {
          resolve = value
        })
    )
  })
  rendered.rerender(tree('account-b'))
  expect(store.sessions).toEqual({})
  const otherSide = { ...side, taskId: 'account-b-side' }
  await act(async () => {
    store.update(key, () => ({
      source,
      payload,
      address: null,
      answers: { audience: 'account-b answer' },
    }))
    await store.create(key, async () => otherSide)
  })
  act(() =>
    oldStore.update(key, current => ({
      ...current!,
      answers: { audience: 'late private answer' },
    }))
  )
  await act(async () => {
    resolve(side)
    await pending
  })
  expect(store.sessions[key]).toMatchObject({
    address: otherSide,
    answers: { audience: 'account-b answer' },
  })
  expect(screen.getByRole('textbox', { name: 'Keep connection input' })).toHaveValue(
    'connection draft'
  )
  rendered.rerender(tree('account-a'))
  expect(store.sessions[key]).toMatchObject({
    address: side,
    answers: { audience: 'late private answer' },
  })
})

test('a late answer check cannot close a newer discussion', async () => {
  let resolve!: (page: object) => void
  mock.load.mockReturnValue(
    new Promise(value => {
      resolve = value
    })
  )
  const other = {
    ...payload,
    requestId: 99,
    questions: [{ id: 'format', question: '输出什么格式？' }],
  }
  render(
    <QuestionDiscussionProvider>
      <WorkbenchPaneContext.Provider
        value={
          {
            createTemporaryRuntimeTask: mock.create,
            loadRuntimeTranscriptForPane: mock.load,
          } as unknown as WorkbenchPaneContextValue
        }
      >
        <QuestionDiscussionScope>
          <RequestUserInputCard payload={payload} source={source} onSubmit={submit} />
          <RequestUserInputCard payload={other} source={source} onSubmit={submit} />
        </QuestionDiscussionScope>
      </WorkbenchPaneContext.Provider>
    </QuestionDiscussionProvider>
  )
  fireEvent.click(screen.getAllByTestId('request-user-input-discuss')[0])
  changeConclusion()
  apply()
  fireEvent.click(within(dialog()).getByTestId('question-discussion-close'))
  fireEvent.click(screen.getAllByTestId('request-user-input-discuss')[1])
  await act(async () => {
    resolve({ messages: [originalMessage()], turns: [] })
  })
  expect(dialog()).toHaveTextContent('输出什么格式？')
  expect(submit).not.toHaveBeenCalled()
})
