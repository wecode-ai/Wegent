import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  ConversationTranslationProvider,
  MessageList,
  type MessageListProps,
} from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import * as assistantMessageModule from '../../../../packages/collaboration/src/conversation/AssistantMessage'

const messages: WorkbenchMessage[] = [
  {
    id: 'selected-response',
    role: 'assistant',
    content: 'Select this response',
    status: 'done',
    createdAt: '2026-10-15T00:00:00Z',
  },
]

function renderList() {
  const onAddSelectionToConversation = vi.fn()
  const onAskSelectionInSidebar = vi.fn()
  const renderMessage = vi.spyOn(assistantMessageModule, 'AssistantMessage')
  const props: MessageListProps = {
    messages,
    virtualize: false,
    conversationKey: 'selection-conversation',
    userMessageServices: {
      images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
    },
    onAddSelectionToConversation,
    onAskSelectionInSidebar,
  }
  render(
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <MessageList {...props} />
      <input data-testid="conversation-find-input" defaultValue="query" />
      <textarea data-testid="outside-textarea" defaultValue="draft" />
      <div data-testid="outside-editor" contentEditable suppressContentEditableWarning>
        Editable draft
      </div>
      <p data-testid="outside-prose">Outside response</p>
    </ConversationTranslationProvider>
  )
  const content = screen.getByTestId('assistant-message-content')
  const list = content.closest('article')!.parentElement!
  expect(renderMessage).toHaveBeenCalled()
  return { content, list, onAddSelectionToConversation, onAskSelectionInSidebar, renderMessage }
}

function selectText(container: HTMLElement, text: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && !node.textContent?.includes(text)) node = walker.nextNode()
  if (!node) throw new Error(`Missing text: ${text}`)
  const start = node.textContent!.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: vi.fn(() => ({ left: 100, top: 100, width: 80, height: 20 })),
  })
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return range
}

async function selectionFrame() {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

describe('message selection while editing elsewhere', () => {
  test.each(['conversation-find-input', 'outside-textarea', 'outside-editor'])(
    'ignores retained response selections while editing %s',
    async editorTestId => {
      const { content, list, onAddSelectionToConversation, renderMessage } = renderList()
      const range = selectText(content, 'Select this')
      fireEvent.mouseUp(content)
      expect(screen.getByTestId('message-selection-actions')).toBeInTheDocument()
      const scan = vi.spyOn(list, 'querySelectorAll')
      const editor = screen.getByTestId(editorTestId)

      act(() => editor.focus())
      expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()
      renderMessage.mockClear()
      // A focused editor can coexist with the previous document Selection.
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      fireEvent.keyUp(editor, { key: 'Backspace' })
      fireEvent(document, new Event('selectionchange'))
      await selectionFrame()

      expect(scan).not.toHaveBeenCalledWith('[data-message-selectable-text]')
      expect(renderMessage).not.toHaveBeenCalled()
      expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()
      expect(onAddSelectionToConversation).not.toHaveBeenCalled()
    }
  )

  test('clears a captured response without scanning message bodies when selection moves outside', async () => {
    const { content, list } = renderList()
    selectText(content, 'Select')
    fireEvent.mouseUp(content)
    expect(screen.getByTestId('message-selection-actions')).toBeInTheDocument()
    const scan = vi.spyOn(list, 'querySelectorAll')
    const outside = screen.getByTestId('outside-prose')
    selectText(outside, 'Outside')
    fireEvent(document, new Event('selectionchange'))
    await selectionFrame()

    expect(scan).not.toHaveBeenCalledWith('[data-message-selectable-text]')
    expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()
  })

  test('keeps identical selection events from rendering the message body again', async () => {
    const { content, renderMessage } = renderList()
    selectText(content, 'Select this')
    fireEvent.mouseUp(content)
    expect(screen.getByTestId('message-selection-actions')).toBeInTheDocument()
    renderMessage.mockClear()

    fireEvent.keyUp(content, { key: 'Shift' })
    fireEvent.mouseUp(content)
    fireEvent(document, new Event('selectionchange'))
    await selectionFrame()

    expect(renderMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('message-selection-actions')).toBeInTheDocument()
  })

  test('updates the selection toolbar when the same selected text moves', () => {
    const { content } = renderList()
    const range = selectText(content, 'Select')
    fireEvent.mouseUp(content)
    expect(screen.getByTestId('message-selection-actions')).toHaveStyle({ top: '92px' })
    vi.mocked(range.getBoundingClientRect).mockReturnValue({
      left: 100,
      top: 160,
      width: 80,
      height: 20,
    } as DOMRect)
    fireEvent.keyUp(content, { key: 'Shift' })

    expect(screen.getByTestId('message-selection-actions')).toHaveStyle({ top: '152px' })
  })

  test('preserves the captured text while clicking either selection action', async () => {
    const { content, onAddSelectionToConversation, onAskSelectionInSidebar } = renderList()
    selectText(content, 'Select this')
    fireEvent.mouseUp(content)
    await userEvent.click(screen.getByTestId('add-selection-to-conversation-button'))
    expect(onAddSelectionToConversation).toHaveBeenCalledWith('Select this')
    expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()

    selectText(content, 'response')
    fireEvent.mouseUp(content)
    await userEvent.click(screen.getByTestId('ask-selection-in-sidebar-button'))
    expect(onAskSelectionInSidebar).toHaveBeenCalledWith('response')
    expect(screen.queryByTestId('message-selection-actions')).not.toBeInTheDocument()
  })
})
