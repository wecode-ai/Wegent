import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import { conversationOutcomePresentation } from '@/components/layout/workspace-panels/conversationOutcomePresentation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  ConversationTranslationProvider,
  MessageList,
  type MessageListProps,
} from '@wegent/collaboration/conversation'
import { describe, expect, test, vi } from 'vitest'
import { buildUserTurnsForNavigation } from '../../../../packages/collaboration/src/conversation/turnNavigationUtils'

const userMessage: WorkbenchMessage = {
  id: 'user-1',
  role: 'user',
  content: 'Original prompt',
  status: 'done',
  createdAt: '2026-09-17T00:00:00Z',
}
const assistantMessage: WorkbenchMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'The answer',
  status: 'done',
  createdAt: '2026-09-17T00:00:01Z',
}

function renderList(overrides: Partial<MessageListProps> = {}) {
  const onEditLastUserMessage = vi.fn().mockResolvedValue(true)
  const props: MessageListProps = {
    messages: [userMessage, assistantMessage],
    userMessageServices: {
      images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
    },
    onEditLastUserMessage,
    canEditLastUserMessage: true,
    ...overrides,
  }
  const view = render(
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <MessageList {...props} />
    </ConversationTranslationProvider>
  )
  return { props, onEditLastUserMessage, ...view }
}

function editMessage() {
  fireEvent.pointerEnter(
    within(screen.getByTestId('message-user')).getByTestId('message-hover-region')
  )
  fireEvent.click(screen.getByTestId('edit-message-button'))
  return screen.getByTestId('edit-user-message-textarea') as HTMLElement & { value: string }
}

describe('full shared message list in a browser host', () => {
  test.each([
    ['stand-in', 'streaming'],
    ['stand-in', 'done'],
    ['stand-in', 'failed'],
    ['task', 'streaming'],
    ['task', 'done'],
    ['task', 'failed'],
  ] as const)(
    'preserves the %s message boundaries and execution presentation when %s',
    (surface, status) => {
      const turn: RuntimeConversationTurn = {
        id: 'native',
        status,
        ...(status === 'failed' ? { error: 'Connection lost' } : {}),
        ...(status !== 'streaming' ? { completedAt: Date.now(), durationMs: 5000 } : {}),
        startedAt: Date.now() - 5000,
        items: [
          { id: 'user', type: 'user_message', message: { ...userMessage, id: 'user' } },
          {
            id: 'ack',
            type: 'assistant_text',
            content: 'I will check in the background.',
            createdAt: assistantMessage.createdAt!,
          },
          {
            id: 'child',
            type: 'block',
            block: {
              id: 'child',
              type: 'subagent',
              subtaskId: 'native',
              status: 'done',
              title: 'Background investigation',
              createdAt: Date.now() - 4000,
            },
          },
          {
            id: 'result',
            type: 'assistant_text',
            content: 'Here is the finished result.',
            createdAt: assistantMessage.createdAt!,
          },
        ],
      }
      const presentation =
        surface === 'stand-in'
          ? conversationOutcomePresentation([], [turn])
          : { messages: projectRuntimeConversationTurns([turn]), turns: [turn] }
      renderList({
        ...presentation,
        ...(surface === 'stand-in'
          ? { assistantMessageStyle: 'bubble', showProcessingStatus: false }
          : {}),
      })
      const replies = screen.getAllByTestId('message-assistant')
      if (status === 'failed') expect(screen.getByText('Connection lost')).toBeInTheDocument()
      if (surface === 'stand-in') {
        expect(replies).toHaveLength(2)
        expect(replies[0]).toHaveTextContent('I will check in the background.')
        expect(replies[0]).not.toHaveTextContent('Here is the finished result.')
        expect(replies[1]).toHaveTextContent('Here is the finished result.')
        expect(screen.queryByTestId('processing-duration-label')).not.toBeInTheDocument()
        expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
        for (const content of screen.getAllByTestId('assistant-message-content'))
          expect(content).toHaveClass('rounded-3xl', 'bg-muted')
      } else {
        expect(replies).toHaveLength(1)
        expect(screen.getByTestId('processing-duration-label')).toBeInTheDocument()
        for (const content of screen.getAllByTestId('assistant-message-content'))
          expect(content).not.toHaveClass('bg-muted')
      }
    }
  )

  test('stand-in guidance remains a user message rather than an execution block', () => {
    const turn: RuntimeConversationTurn = {
      id: 'guidance-turn',
      status: 'streaming',
      startedAt: Date.now() - 5000,
      items: [
        { id: 'user', type: 'user_message', message: { ...userMessage, id: 'user' } },
        { id: 'ack', type: 'assistant_text', content: 'First acknowledgement.', createdAt: '' },
        {
          id: 'next',
          type: 'user_message',
          message: {
            ...userMessage,
            id: 'next',
            content: 'Another thing.',
            runtimeGuidance: true,
          },
        },
        { id: 'reply', type: 'assistant_text', content: 'Second acknowledgement.', createdAt: '' },
      ],
    }
    renderList({
      ...conversationOutcomePresentation([], [turn]),
      assistantMessageStyle: 'bubble',
      showProcessingStatus: false,
    })
    expect(screen.getAllByTestId('message-user')).toHaveLength(2)
    expect(screen.getAllByTestId('message-assistant')).toHaveLength(2)
    expect(screen.queryByTestId('processing-duration-label')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/引导对话|Guiding conversation|Guide conversation/i)
    ).not.toBeInTheDocument()
  })

  test('stand-in outcome presentation retains actionable questions without execution timing', () => {
    const turn: RuntimeConversationTurn = {
      id: 'question-turn',
      status: 'streaming',
      startedAt: Date.now() - 5000,
      items: [
        {
          id: 'question',
          type: 'block',
          block: {
            id: 'question',
            type: 'tool',
            toolName: 'request_user_input',
            subtaskId: 'question-turn',
            status: 'pending',
            createdAt: Date.now(),
            renderPayload: {
              kind: 'request_user_input',
              questions: [
                {
                  id: 'source',
                  header: 'Source',
                  question: 'Choose a source',
                  options: [{ label: 'Release page', description: 'Read published versions' }],
                },
              ],
            },
          },
        },
      ],
    }
    renderList({
      ...conversationOutcomePresentation([], [turn]),
      assistantMessageStyle: 'bubble',
      showProcessingStatus: false,
      onRequestUserInputSubmit: vi.fn(),
    })
    expect(screen.getByTestId('request-user-input-card')).toBeInTheDocument()
    expect(screen.getByText('Choose a source')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-duration-label')).not.toBeInTheDocument()
    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
  })
  test.each(['plain', 'bubble'] as const)(
    'renders assistant text using the %s presentation',
    assistantMessageStyle => {
      renderList({ assistantMessageStyle })
      const content = screen.getByTestId('assistant-message-content')
      expect(content).toHaveTextContent('The answer')
      if (assistantMessageStyle === 'bubble') {
        expect(content).toHaveClass('rounded-3xl', 'bg-muted', 'px-4', 'py-3')
      } else {
        expect(content).not.toHaveClass('bg-muted')
      }
      expect(screen.getByTestId('message-user')).toHaveTextContent('Original prompt')
    }
  )
  const activity: WorkbenchMessage = {
    ...userMessage,
    id: 'host-activity',
    turnId: 'activity-turn',
    source: { source: 'stand_in_activity' },
  }
  const trace: WorkbenchMessage = {
    ...assistantMessage,
    turnId: activity.turnId,
    content: '',
    blocks: [
      {
        id: 'thinking',
        subtaskId: 'task',
        type: 'thinking',
        status: 'done',
        createdAt: 0,
        content: 'Internal check',
      },
      {
        id: 'tool',
        subtaskId: 'task',
        type: 'tool',
        status: 'done',
        createdAt: 0,
        completedAt: 18000,
        durationMs: 18000,
        toolName: 'wework_stand_in.task_read',
        toolOutput: { done: true },
      },
    ],
  }

  test('renders no rows, timing or navigation points for a completed internal trace', () => {
    const messages = [activity, trace]
    const { container } = renderList({ messages })
    expect(container.textContent).toBe('')
    expect(container.querySelector('article, button, [data-message-row]')).toBeNull()
    expect(buildUserTurnsForNavigation(messages)).toEqual([])
    expect(
      buildUserTurnsForNavigation(messages, [
        {
          id: 'native-turn',
          turnId: activity.turnId,
          userMessageId: activity.id,
          messageIndex: 0,
          promptPreview: activity.content,
        },
      ])
    ).toEqual([])
    expect(
      buildUserTurnsForNavigation(messages, [
        {
          id: 'native-turn',
          turnId: activity.turnId,
          userMessageId: null,
          messageIndex: 0,
          promptPreview: activity.content,
        },
      ])
    ).toEqual([])
  })

  test.each([
    undefined,
    { source: 'manual' },
    { source: 'im', channel_type: 'dingtalk' },
    { source: 'stand_in_activity_extra' },
  ])('retains ordinary or unknown user sources and their trace: %j', source => {
    const messages = [{ ...activity, source }, trace]
    renderList({ messages })
    expect(screen.getByTestId('message-user')).toHaveTextContent(userMessage.content)
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
    expect(buildUserTurnsForNavigation(messages)).toHaveLength(1)
  })

  test.each(['The answer', '已核对，没有新信息'])(
    'retains actual assistant output verbatim: %s',
    content => {
      renderList({ messages: [activity, { ...trace, content }] })
      expect(screen.queryByTestId('message-user')).not.toBeInTheDocument()
      expect(screen.getByTestId('message-assistant')).toHaveTextContent(content)
    }
  )

  test.each<Partial<WorkbenchMessage>>([
    { status: 'streaming' },
    { status: 'pending' },
    { status: 'failed', error: 'Unable to read result' },
    { runtimeStatus: 'cancelled', stoppedNotice: true },
    {
      blocks: [
        {
          id: 'question',
          subtaskId: 'task',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'done',
          createdAt: 0,
          renderPayload: {
            kind: 'request_user_input',
            requestId: 'question',
            questions: [
              {
                id: 'choice',
                header: 'Choice',
                question: 'Which result should be delivered?',
                options: [],
              },
            ],
          },
        },
      ],
    },
    {
      blocks: [
        {
          id: 'approval',
          subtaskId: 'task',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          createdAt: 0,
          renderPayload: {
            kind: 'request_user_input',
            requestId: 'approval',
            questions: [
              { id: 'approve', header: 'Approval', question: 'Approve delivery?', options: [] },
            ],
          },
        },
      ],
    },
    {
      blocks: [
        {
          id: 'error',
          subtaskId: 'task',
          type: 'tool',
          toolName: 'wework_stand_in.task_read',
          status: 'error',
          createdAt: 0,
          toolOutput: 'Read failed',
        },
      ],
    },
    {
      blocks: [
        {
          id: 'text',
          subtaskId: 'task',
          type: 'text',
          status: 'done',
          createdAt: 0,
          content: 'Result in a text block',
        },
      ],
    },
    {
      blocks: [
        {
          id: 'plan',
          subtaskId: 'task',
          type: 'plan',
          status: 'done',
          createdAt: 0,
          content: 'A useful plan',
        },
      ],
    },
    {
      references: [{ path: '/workspace/result.md', lineStart: 1, lineEnd: 2 }],
    },
    {
      memoryCitations: [{ entries: [{ path: 'MEMORY.md', lineStart: 1, lineEnd: 2 }] }],
    },
    {
      fileChanges: {
        version: 1,
        status: 'active',
        artifact_id: 'result',
        device_id: 'device',
        workspace_path: '/workspace',
        file_count: 1,
        additions: 1,
        deletions: 0,
        files: [
          { path: 'result.md', change_type: 'created', additions: 1, deletions: 0, binary: false },
        ],
      },
    },
  ])('preserves an internal turn with output, input or non-success state: %j', change => {
    renderList({ messages: [activity, { ...trace, ...change }] })
    expect(screen.queryByTestId('message-user')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
  })

  test('does not associate ordinary assistant traces with a different host turn', () => {
    renderList({ messages: [activity, { ...trace, turnId: 'other-turn' }] })
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
  })

  test('preserves real user guidance and its tool traces in a mixed host turn', () => {
    const guidance = { ...userMessage, turnId: activity.turnId, runtimeGuidance: true }
    const messages = [activity, guidance, trace]
    renderList({ messages })
    expect(screen.getByTestId('message-user')).toHaveTextContent(guidance.content)
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
    expect(buildUserTurnsForNavigation(messages)).toMatchObject([{ id: guidance.id }])
  })

  test('keeps a pending native turn visible even when its assistant item is complete', () => {
    renderList({
      messages: [activity, trace],
      turns: [{ id: activity.turnId!, status: 'streaming', items: [] }],
    })
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
  })

  test('hides a native empty completion without processing blocks', () => {
    const { container } = renderList({ messages: [activity, { ...trace, blocks: [] }] })
    expect(container.textContent).toBe('')
    expect(container.querySelector('article, button')).toBeNull()
  })

  test('retains an unloaded navigation item with a different explicit user identity', () => {
    expect(
      buildUserTurnsForNavigation(
        [activity, trace],
        [
          {
            id: 'unknown-user',
            userMessageId: 'unknown-user',
            turnId: activity.turnId,
            messageIndex: 2,
            promptPreview: 'Unknown user',
          },
        ]
      )
    ).toHaveLength(1)
  })

  test('cancels message editing with Escape when no autocomplete menu is open', () => {
    const { onEditLastUserMessage } = renderList()
    const editor = editMessage()
    expect(editor).toHaveAttribute('contenteditable', 'true')
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('Original prompt')
    expect(onEditLastUserMessage).not.toHaveBeenCalled()
  })

  test('does not submit an IME confirmation and submits the edited value after key release', async () => {
    const { onEditLastUserMessage } = renderList()
    const editor = editMessage()
    act(() => {
      editor.value = '修改后的问题'
    })
    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onEditLastUserMessage).not.toHaveBeenCalled()
    fireEvent.keyUp(editor, { key: 'Enter' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() =>
      expect(onEditLastUserMessage).toHaveBeenCalledWith(userMessage, '修改后的问题')
    )
    await waitFor(() =>
      expect(screen.queryByTestId('edit-user-message-form')).not.toBeInTheDocument()
    )
  })

  test('keeps a rejected edit available with its Markdown and current draft', async () => {
    const save = vi.fn().mockResolvedValue(false)
    renderList({ onEditLastUserMessage: save })
    const editor = editMessage()
    act(() => {
      editor.value = '**Updated** prompt'
    })
    fireEvent.click(screen.getByTestId('submit-edit-user-message-button'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(userMessage, '**Updated** prompt'))
    expect(screen.getByTestId('edit-user-message-form')).toBeInTheDocument()
    expect(within(editor).getByText('Updated').tagName).toBe('STRONG')
    expect(editor.value).toBe('**Updated** prompt')
  })

  test('uses the injected path transfer service when pasting into a message edit', async () => {
    const resolveTransfer = vi.fn().mockResolvedValue({
      referenceEntries: [{ path: '/workspace/src', isDirectory: true }],
      attachmentFiles: [],
    })
    renderList({
      userMessageServices: {
        images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
        transfers: { hasPathTransfer: () => true, resolveTransfer },
      },
    })
    const editor = editMessage()
    const clipboardData = {
      files: [new File(['text'], 'src')],
      types: ['Files'],
      getData: () => '',
    }
    fireEvent.paste(editor, { clipboardData })
    await waitFor(() => expect(editor.value).toContain('[$src](folder://%2Fworkspace%2Fsrc)'))
    expect(editor.value).toContain('Original prompt')
    expect(resolveTransfer).toHaveBeenCalledWith(clipboardData, 'clipboard')
  })

  test('preserves reference identity while disabling absent file actions', () => {
    renderList({
      messages: [{ ...userMessage, content: '[$spec](file://%2Fworkspace%2Fspec.md)' }],
    })
    const reference = screen.getByTestId('sent-file-token-spec')
    expect(reference).toHaveAttribute('href', 'file://%2Fworkspace%2Fspec.md')
    expect(reference).toHaveAttribute('aria-disabled', 'true')
    expect(reference).toHaveAttribute('tabindex', '-1')
    expect(reference).toHaveTextContent('spec')
  })
})
