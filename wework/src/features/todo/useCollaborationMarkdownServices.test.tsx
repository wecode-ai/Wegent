import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantMarkdown, MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from '@/components/chat/useDesktopMarkdownServices'
import { useCollaborationMarkdownServices } from './useCollaborationMarkdownServices'

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
  readLocalFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
}))

vi.mock('@/lib/external-links', () => ({ openExternalUrl: mocks.openExternalUrl }))
vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile: mocks.readLocalFile }))

afterEach(() => {
  delete window.__WEWORK_RUNTIME_CONFIG__
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

test('routes both comment link types through desktop link preferences', () => {
  const { result } = renderHook(useCollaborationMarkdownServices)
  render(
    <MarkdownServicesProvider value={result.current}>
      <AssistantMarkdown content="[wecode-ai/Wegent#3966](https://github.com/wecode-ai/Wegent/pull/3966)\n\n[docs](https://example.com/docs)" />
    </MarkdownServicesProvider>
  )

  fireEvent.click(screen.getByTestId('composer-link-chip'))
  fireEvent.click(screen.getByTestId('assistant-markdown-link'))

  expect(mocks.openExternalUrl).toHaveBeenNthCalledWith(
    1,
    'https://github.com/wecode-ai/Wegent/pull/3966'
  )
  expect(mocks.openExternalUrl).toHaveBeenNthCalledWith(2, 'https://example.com/docs')
})

test.each(['composer-link-chip', 'assistant-markdown-link'])(
  'keeps private URL details out of %s failure logs',
  async testId => {
    const error = new Error(
      'Failed to open https://alice:private-password@example.com/private-document?token=private-token#private-section'
    )
    mocks.openExternalUrl.mockRejectedValueOnce(error)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(useCollaborationMarkdownServices)
    render(
      <MarkdownServicesProvider value={result.current}>
        <AssistantMarkdown content="[wecode-ai/Wegent#3966](https://github.com/wecode-ai/Wegent/pull/3966)\n\n[docs](https://example.com/docs)" />
      </MarkdownServicesProvider>
    )

    fireEvent.click(screen.getByTestId(testId))

    await waitFor(() => expect(errorLog).toHaveBeenCalledTimes(1))
    const loggedValues = JSON.stringify(errorLog.mock.calls, (_key, value) =>
      value instanceof Error ? `${value.name}: ${value.message}` : value
    )
    for (const sensitiveValue of [
      'alice',
      'private-password',
      'private-document',
      'private-token',
      'private-section',
    ]) {
      expect(loggedValues).not.toContain(sensitiveValue)
    }
    expect(errorLog).toHaveBeenCalledWith(expect.any(String), { error: 'Error' })
  }
)

test('does not grant collaboration content access to desktop files or visualizations', () => {
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
  const { result } = renderHook(useCollaborationMarkdownServices)
  render(
    <MarkdownServicesProvider value={result.current}>
      <AssistantMarkdown content="![private](/Users/viewer/private.png)\n\n![private](C:/Users/viewer/private.png)" />
    </MarkdownServicesProvider>
  )

  expect(screen.getAllByTestId('assistant-markdown-image-loading')).toHaveLength(2)
  expect(mocks.readLocalFile).not.toHaveBeenCalled()
  expect(result.current.readLocalFile).toBeUndefined()
  expect(result.current.openHtmlFile).toBeUndefined()
  expect(result.current.renderVisualization).toBeUndefined()
})

test('preserves local file capabilities for desktop conversations', async () => {
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
  const { result } = renderHook(useDesktopMarkdownServices)

  await result.current.readLocalFile?.('C:/Users/viewer/private.png')

  expect(mocks.readLocalFile).toHaveBeenCalledWith('C:/Users/viewer/private.png')
  expect(result.current.openHtmlFile).toEqual(expect.any(Function))
  expect(result.current.renderVisualization).toEqual(expect.any(Function))
})
