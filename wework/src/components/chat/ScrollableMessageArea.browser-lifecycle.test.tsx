import { act, render, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { expect, test, vi } from 'vitest'
import {
  ConversationTranslationProvider,
  ScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { ElectronEmbeddedBrowserView } from '@/components/layout/workspace-panels/ElectronEmbeddedBrowserView'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { requestWorkbenchComposerFocus } from '@/lib/workbenchComposerFocus'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async () => ({})),
}))

const projectChat = {
  scopeKey: 'runtime:cold-message-browser:task',
  models: [],
  skills: [],
  selectedModel: null,
  selectedModelOptions: {},
  selectedSkills: [],
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
  isOptionsLocked: false,
  setSelectedModel: vi.fn(),
  setSelectedModelOption: vi.fn(),
  toggleSkill: vi.fn(),
  handleFileSelect: vi.fn(async () => {}),
  removeAttachment: vi.fn(),
  listLocalSkills: vi.fn(async () => []),
}

const markdown = vi.hoisted(() => {
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { pending, release, load: vi.fn() }
})
vi.mock(
  '../../../../packages/collaboration/src/markdown/AssistantMarkdownRenderer',
  async importOriginal => {
    markdown.load()
    await markdown.pending
    return importOriginal()
  }
)

function WorkbenchSurface({
  messages,
  onContentReady,
}: Pick<ScrollableMessageAreaProps, 'messages' | 'onContentReady'>) {
  return (
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <Suspense fallback={<p>Loading workbench</p>}>
        <ScrollableMessageArea
          messages={messages}
          onContentReady={onContentReady}
          virtualize={false}
          userMessageServices={{
            images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
          }}
        />
        <ElectronEmbeddedBrowserView
          active
          interactionBlocked={false}
          label="cold-message-browser"
          visualRect={{ left: 100, top: 100, width: 600, height: 400 }}
        />
        <div data-active-workbench-pane="true">
          <BufferedChatInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            projectChat={projectChat}
          />
        </div>
      </Suspense>
    </ConversationTranslationProvider>
  )
}

test('preserves the connected browser host while the first message renderer loads and reports content only after commit', async () => {
  const ready = vi.fn(() => expect(screen.getByText('First task answer')).toBeVisible())
  const { rerender } = render(<WorkbenchSurface messages={[]} onContentReady={ready} />)
  const browser = screen.getByTestId('workspace-browser-electron-webview')
  const webview = browser.querySelector('webview')
  expect(browser.isConnected).toBe(true)
  expect(browser).toBeVisible()
  expect(markdown.load).not.toHaveBeenCalled()
  requestWorkbenchComposerFocus(projectChat.scopeKey)
  const composer = screen.getByTestId('chat-message-input')
  await waitFor(() => expect(composer).toHaveFocus())
  rerender(
    <WorkbenchSurface
      messages={[
        {
          id: 'first-answer',
          role: 'assistant',
          content: 'First task answer',
          status: 'done',
          createdAt: '2026-10-13T00:00:00Z',
        },
      ]}
      onContentReady={ready}
    />
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(markdown.load).toHaveBeenCalledOnce()
  expect(composer).toBeVisible()
  expect(composer).toHaveFocus()
  expect(browser.isConnected).toBe(true)
  expect(browser).toBeVisible()
  expect(browser.querySelector('webview')).toBe(webview)
  expect(screen.getByTestId('chat-message-input')).toBe(composer)
  expect(composer).toHaveFocus()
  expect(ready).not.toHaveBeenCalled()
  await act(async () => {
    markdown.release()
    await vi.dynamicImportSettled()
  })
  expect(await screen.findByText('First task answer')).toBeVisible()
  await waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(screen.getByTestId('workspace-browser-electron-webview')).toBe(browser)
  expect(browser.querySelector('webview')).toBe(webview)
  expect(screen.getByTestId('chat-message-input')).toBe(composer)
  expect(composer).toHaveFocus()
})
