import { copyTextToClipboard } from '@/lib/clipboard'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import {
  AssistantMarkdown as SharedAssistantMarkdown,
  MarkdownServicesProvider,
  browserMarkdownServices,
} from '@wegent/collaboration/markdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

test('renders Windows drive-letter markdown links as file links instead of [blocked]', () => {
  const onOpenFile = vi.fn()
  render(
    <AssistantMarkdown content="[wegent](C:/projects/example-app/wegent)" onOpenFile={onOpenFile} />
  )

  const link = screen.getByTestId('assistant-markdown-link')
  expect(link).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()

  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledWith('C:/projects/example-app/wegent')
})

test('renders backslash Windows drive-letter markdown links as file links', () => {
  render(<AssistantMarkdown content="[wegent](C:\\projects\\example-app\\wegent)" />)

  expect(screen.getByTestId('assistant-markdown-link')).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()
})

test.each(['default', 'document', 'user'] as const)(
  'preserves SQL regex text in code and copied code for %s messages',
  async variant => {
    const sql = "regexp_extract(analysis_extra, 'cate[=:]([0-9]+)', 1)"
    vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined)
    render(
      <AssistantMarkdown content={`\`${sql}\`\n\n\`\`\`sql\n${sql}\n\`\`\``} variant={variant} />
    )

    const code = document.querySelectorAll('code')
    expect(code).toHaveLength(2)
    for (const element of code) expect(element.textContent).toBe(sql)
    fireEvent.click(screen.getByTestId('markdown-code-copy-button'))
    await vi.waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(sql))
  }
)

test.each([
  ['/tmp/report.md', '/tmp/report.md'],
  ['file:///tmp/report.md', '/tmp/report.md'],
  ['folder:///tmp/reports', '/tmp/reports'],
  ['src/main.ts:12', 'src/main.ts'],
])('keeps opening %s in Wework', (href, path) => {
  const onOpenFile = vi.fn()
  render(<AssistantMarkdown content={`[文件](${href})`} onOpenFile={onOpenFile} />)

  fireEvent.click(screen.getByTestId('assistant-markdown-link'))

  expect(onOpenFile.mock.calls[0][0]).toBe(path)
})

test.each(['wework://tasks/example', 'skill://example', 'app://example'])(
  'passes the original %s URL to the Wework link renderer',
  href => {
    const renderLink = vi.fn(() => <button data-testid="custom-link">打开</button>)
    render(<AssistantMarkdown content={`[打开](${href})`} renderLink={renderLink} />)

    expect(screen.getByTestId('custom-link')).toBeInTheDocument()
    expect(renderLink).toHaveBeenCalledWith(href, '打开')
  }
)

test.each(['javascript:alert%281%29', 'data:text/html,unsafe', 'vbscript:msgbox%281%29'])(
  'keeps unsafe URL %s out of rendered links',
  href => {
    const renderLink = vi.fn()
    const { container } = render(
      <AssistantMarkdown content={`[unsafe](${href})`} renderLink={renderLink} />
    )

    expect(renderLink).not.toHaveBeenCalled()
    expect(container.querySelector('[href]')).toBeNull()
  }
)

test.each(['/tmp/plot.png', 'file:///tmp/plot.png'])(
  'reads local image %s without rewriting its URL',
  async src => {
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
        <SharedAssistantMarkdown content={`![plot](${src})`} />
      </MarkdownServicesProvider>
    )
    try {
      await vi.waitFor(() => {
        expect(readLocalFile).toHaveBeenCalledExactlyOnceWith('/tmp/plot.png')
        expect(screen.getByRole('img', { name: 'plot' })).toHaveAttribute(
          'src',
          'blob:local-preview'
        )
      })
    } finally {
      unmount()
      vi.unstubAllGlobals()
    }
  }
)
