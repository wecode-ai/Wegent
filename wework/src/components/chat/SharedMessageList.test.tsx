import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  ConversationTranslationProvider,
  MessageList,
  type MessageListProps,
} from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

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
const asyncQuestion: WorkbenchMessage = {
  id: 'assistant-question',
  role: 'assistant',
  content: '',
  status: 'done',
  createdAt: '2026-09-17T00:00:01Z',
  blocks: [
    {
      id: 'request-user-input-call-question',
      subtaskId: 'subtask-1',
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 1,
      renderPayload: {
        kind: 'request_user_input',
        delivery: 'async',
        itemId: 'call-question',
        questions: [
          { id: 'q1', question: '晴天还是雨天?' },
          { id: 'q2', question: '早上还是晚上?' },
          { id: 'q3', question: '猫还是狗?' },
        ],
      },
    },
  ],
}
const asyncReply: WorkbenchMessage = {
  id: 'user-reply',
  role: 'user',
  content: '晴天\n早上\n猫',
  status: 'done',
  createdAt: '2026-09-17T00:00:02Z',
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
  render(
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <MessageList {...props} />
    </ConversationTranslationProvider>
  )
  return { props, onEditLastUserMessage }
}

function editMessage() {
  fireEvent.pointerEnter(
    within(screen.getByTestId('message-user')).getByTestId('message-hover-region')
  )
  fireEvent.click(screen.getByTestId('edit-message-button'))
  return screen.getByTestId('edit-user-message-textarea') as HTMLElement & { value: string }
}

describe('full shared message list in a browser host', () => {
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

  test('shows what a non-blocking answer replied to', () => {
    renderList({ messages: [asyncQuestion, asyncReply] })
    const reply = within(screen.getByTestId('user-message-question-reply'))
    const answered = ['晴天还是雨天?', '晴天', '早上还是晚上?', '早上', '猫还是狗?', '猫']
    answered.forEach(text => expect(reply.getByText(text)).toBeInTheDocument())
  })

  test('renders an ordinary user message without a question reference', () => {
    renderList()
    expect(screen.queryByTestId('user-message-question-reply')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-message-content')).toHaveTextContent('Original prompt')
  })
})
