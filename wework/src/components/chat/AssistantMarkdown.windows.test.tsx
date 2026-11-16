import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  AssistantMarkdown as SharedAssistantMarkdown,
  MarkdownServicesProvider,
  browserMarkdownServices,
} from '@wegent/collaboration/markdown'
import { AssistantMarkdown } from './AssistantMarkdown'

test.each(['default', 'document', 'user'] as const)(
  'opens a slash-prefixed Windows SQL link with its line range in %s Markdown',
  variant => {
    const onOpenFile = vi.fn()
    render(
      <AssistantMarkdown
        content="[整体分层 SQL](/D:/wenyu-ai/vault/07-研究课题/研读与验证/整体分层.sql:12-20)"
        variant={variant}
        onOpenFile={onOpenFile}
      />
    )

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(
      'D:/wenyu-ai/vault/07-研究课题/研读与验证/整体分层.sql',
      { lineStart: 12, lineEnd: 20 }
    )
  }
)

test('reads a slash-prefixed Windows image through the native file service', async () => {
  const readLocalFile = vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:local-preview')
      static revokeObjectURL = vi.fn()
    }
  )
  const { unmount } = render(
    <MarkdownServicesProvider value={{ ...browserMarkdownServices, readLocalFile }}>
      <SharedAssistantMarkdown content="![plot](/D:/研究课题/plot%20one.png)" />
    </MarkdownServicesProvider>
  )
  try {
    await vi.waitFor(() => {
      expect(readLocalFile).toHaveBeenCalledExactlyOnceWith('D:/研究课题/plot one.png')
      expect(screen.getByRole('img', { name: 'plot' })).toHaveAttribute('src', 'blob:local-preview')
    })
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
})
