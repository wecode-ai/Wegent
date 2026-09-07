import { render, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test('uses document typography for every Markdown heading level', () => {
  render(
    <AssistantMarkdown
      content={[
        '# Heading 1',
        '## Heading 2',
        '### Heading 3',
        '#### Heading 4',
        '##### Heading 5',
        '###### Heading 6',
      ].join('\n\n')}
      variant="document"
    />
  )

  expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-heading-lg')
  expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-heading-md')
  expect(screen.getByRole('heading', { level: 3 })).toHaveClass('text-heading-sm')
  expect(screen.getByRole('heading', { level: 4 })).toHaveClass('text-lg')
  expect(screen.getByRole('heading', { level: 5 })).toHaveClass('text-base')
  expect(screen.getByRole('heading', { level: 6 })).toHaveClass('text-sm')
})

test('shows the horizontal scrollbar for completed code blocks in document previews', async () => {
  render(
    <AssistantMarkdown
      content={[
        '```sql',
        "SELECT 'a completed document preview line that is wider than its code block';",
        '```',
      ].join('\n')}
      variant="document"
    />
  )

  expect(screen.getByTestId('markdown-code-scroll-container')).toHaveClass('overflow-x-auto')
  expect(screen.getByTestId('markdown-code-horizontal-scrollbar')).toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-syntax-highlighted',
      'true'
    )
  )
})

test('allows long Markdown links to wrap within narrow message cards', () => {
  const url =
    'http://127.0.0.1:58617/v1/codex-router/task-3fd8b50e7d269add73aff1114746a4a9fab19a10b9b97e19/result'

  render(<AssistantMarkdown content={`[${url}](${url})`} />)

  expect(screen.getByTestId('assistant-markdown-link')).toHaveClass('min-w-0', 'max-w-full')
  expect(screen.getByTestId('assistant-markdown-link-label')).toHaveClass(
    'min-w-0',
    'whitespace-normal',
    '[overflow-wrap:anywhere]'
  )
})
