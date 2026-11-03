import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

const citation = ':codex-file-citation{path="/tmp/report.xlsx"}'

test('hides incomplete streaming attributes and reveals the complete file reference', () => {
  const { rerender } = render(
    <AssistantMarkdown content={'原稿：:codex-file-citation{path="/tmp/private'} isStreaming />
  )
  expect(document.body).not.toHaveTextContent('private')
  expect(screen.queryByTestId('assistant-markdown-link')).not.toBeInTheDocument()
  rerender(<AssistantMarkdown content={`原稿：${citation}`} />)
  expect(screen.getByTestId('assistant-markdown-link')).toHaveTextContent('report.xlsx')
})

test.each(['javascript:alert(1)', 'data:text/html,hello', 'https://example.com/report.xlsx'])(
  'does not interpret %s as a local file',
  path => {
    render(<AssistantMarkdown content={`:codex-file-citation{path="${path}"}`} />)
    expect(document.querySelector('[data-citation-purpose]')).toBeNull()
  }
)
