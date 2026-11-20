import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useContext, useRef, useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { QuestionDiscussionProvider } from './QuestionDiscussionProvider'
import { QuestionDiscussionScope, QuestionDiscussionTabPanel } from './QuestionDiscussionScope'
import {
  canDiscussQuestion,
  questionDiscussionDrafts,
  questionDiscussionKey,
  QuestionDiscussionStoreContext,
  useQuestionDiscussionPanels,
  type QuestionDiscussionStore,
} from './questionDiscussion'
import type { QuestionDiscussionPanel } from './questionDiscussionPanels'
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
function DiscussionTabs({
  address = source,
  active = true,
}: {
  address?: typeof source
  active?: boolean
}) {
  const { snapshot, close } = useQuestionDiscussionPanels({ address, active })
  const [deactivated, setDeactivated] = useState<QuestionDiscussionPanel | null>(null)
  const selected = snapshot.activation === deactivated ? null : snapshot.activation?.tab
  return (
    <>
      <button data-testid="open-another-panel" onClick={() => setDeactivated(snapshot.activation)}>
        Open another panel
      </button>
      {snapshot.panels.map(({ tab }) => (
        <QuestionDiscussionTabPanel
          key={tab}
          tab={tab}
          active={active && selected === tab}
          onClose={() => close(tab)}
        />
      ))}
    </>
  )
}
function StoreProbe() {
  const store = useContext(QuestionDiscussionStoreContext)!
  return (
    <span
      hidden
      ref={element => {
        if (element) latestStore = store
      }}
    />
  )
}
function setup(count = 1, input = payload) {
  function Entries() {
    const [activeIndex, setActiveIndex] = useState(0)
    return (
      <QuestionDiscussionProvider>
        {Array.from({ length: count }, (_, index) => (
          <WorkbenchPaneContext.Provider
            key={index}
            value={
              {
                createTemporaryRuntimeTask: mock.create,
                loadRuntimeTranscriptForPane: mock.load,
                openRuntimeTask: async () => setActiveIndex(index),
              } as unknown as WorkbenchPaneContextValue
            }
          >
            <QuestionDiscussionScope>
              <DiscussionTabs active={activeIndex === index} />
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
  return render(<Entries />)
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
  fireEvent.click(within(dialog()).getByTestId('question-discussion-question'))
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(
    latestStore.sessions[questionDiscussionKey(source, grouped)].payload.questions
  ).toHaveLength(2)
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
  fireEvent.click(within(dialog()).getByTestId('question-discussion-question'))
  fireEvent.click(screen.getByRole('option', { name: '输出格式？' }))
  changeConclusion('PDF')
  apply()
  await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  expect(screen.getByTestId(`request-user-input-custom-${secondId}`)).toHaveValue('PDF')
  expect(screen.getByTestId('request-user-input-custom-audience')).toHaveValue('')
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
  await waitFor(() =>
    expect(screen.getByTestId('request-user-input-custom-adjustment')).toHaveValue(
      '请先补充数据来源，再开始实施。'
    )
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

test('account switches isolate discussion drafts and late creation without remounting unrelated input', async () => {
  let store!: QuestionDiscussionStore
  function Probe() {
    const current = useContext(QuestionDiscussionStoreContext)!
    return (
      <input
        ref={element => {
          if (element) store = current
        }}
        aria-label="Keep connection input"
        defaultValue=""
      />
    )
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
  act(() => oldStore.requestPanel({ key, source }))
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
  expect(store.panelRequest).toBeNull()
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

test.each([true, false])(
  'a late answer check cannot close a newer discussion (closed: %s)',
  async closeBeforeSwitch => {
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
              openRuntimeTask: vi.fn(),
            } as unknown as WorkbenchPaneContextValue
          }
        >
          <QuestionDiscussionScope>
            <DiscussionTabs />
            <RequestUserInputCard payload={payload} source={source} onSubmit={submit} />
            <RequestUserInputCard payload={other} source={source} onSubmit={submit} />
          </QuestionDiscussionScope>
        </WorkbenchPaneContext.Provider>
      </QuestionDiscussionProvider>
    )
    fireEvent.click(screen.getAllByTestId('request-user-input-discuss')[0])
    changeConclusion()
    apply()
    if (closeBeforeSwitch)
      fireEvent.click(within(dialog()).getByTestId('question-discussion-close'))
    fireEvent.click(screen.getAllByTestId('request-user-input-discuss')[1])
    await act(async () => {
      resolve({ messages: [originalMessage()], turns: [] })
    })
    expect(dialog()).toHaveTextContent('输出什么格式？')
    expect(submit).not.toHaveBeenCalled()
  }
)
