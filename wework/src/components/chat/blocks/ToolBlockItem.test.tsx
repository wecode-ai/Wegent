import '@/i18n'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { ToolBlockItem } from './ToolBlockItem'
import type { ProcessingBlock } from '@/types/workbench'

const streamingThinkingBlock: ProcessingBlock = {
  id: 'thinking-1',
  subtaskId: 1,
  type: 'thinking',
  content: 'First step. Latest visible thought',
  status: 'streaming',
  createdAt: 1770000000000,
}

const streamingTextBlock: ProcessingBlock = {
  id: 'text-1',
  subtaskId: 1,
  type: 'text',
  content: 'Let me explore the repository structure.',
  status: 'streaming',
  createdAt: 1770000000001,
}

describe('ToolBlockItem', () => {
  test('renders streaming thinking as a single live preview row', () => {
    render(<ToolBlockItem block={streamingThinkingBlock} />)

    const preview = screen.getByTestId('thinking-live-preview')

    expect(preview).toHaveTextContent('正在思考')
    expect(preview.firstElementChild).toHaveTextContent('正在思考')
    expect(preview.firstElementChild?.tagName).toBe('SPAN')
    expect(preview).toHaveTextContent('Latest visible thought')
    expect(screen.queryByText('First step. Latest visible thought')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thinking-toggle-button')).not.toBeInTheDocument()
  })

  test('renders completed thinking collapsed and expands on click', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          ...streamingThinkingBlock,
          status: 'done',
          content: 'I will inspect the repository before answering.',
        }}
      />
    )

    const toggle = screen.getByTestId('thinking-toggle-button')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.firstElementChild).toHaveTextContent('思考过程')
    expect(toggle.firstElementChild?.tagName).toBe('SPAN')
    expect(screen.queryByTestId('thinking-detail')).not.toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('thinking-detail')).toHaveTextContent(
      'I will inspect the repository before answering.'
    )
  })

  test('renders streaming process text directly in the timeline', () => {
    render(<ToolBlockItem block={streamingTextBlock} />)

    const block = screen.getByTestId('process-text-block')

    expect(block).toHaveAccessibleName('正在处理')
    expect(block).toHaveTextContent('Let me explore the repository structure.')
    expect(block.querySelector('svg')).not.toBeInTheDocument()
    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
  })

  test('renders completed process text without folding it', () => {
    render(<ToolBlockItem block={{ ...streamingTextBlock, status: 'done' }} />)

    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-text-block')).toHaveTextContent(
      'Let me explore the repository structure.'
    )
  })

  test('renders process text code blocks with shared syntax highlighting', () => {
    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: [
            'Use CSS:',
            '',
            '```css',
            '.collapsible {',
            '  display: grid;',
            '}',
            '```',
          ].join('\n'),
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('.collapsible')
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('css')
    expect(screen.queryByTestId('markdown-code-wrap-button')).not.toBeInTheDocument()
  })

  test('renders markdown code labels as md and toggles line wrapping', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: ['```markdown', 'After creating the PR, check for merge conflicts.', '```'].join(
            '\n'
          ),
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('md')

    const wrapButton = screen.getByTestId('markdown-code-wrap-button')
    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    const code = screen.getByTestId('markdown-code-block').querySelector('code')

    expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
    expect(wrapButton).toHaveAttribute('aria-label', '开启自动换行')
    expect(wrapButton).toHaveAttribute('title', '开启自动换行')
    expect(screen.getByTestId('markdown-code-wrap-disabled-icon')).toBeInTheDocument()
    expect(scrollContainer).toHaveAttribute('data-wrap', 'false')
    expect(scrollContainer).toHaveClass('overflow-x-auto')
    expect(code).toHaveStyle({
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      wordBreak: 'normal',
    })

    await user.click(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    expect(wrapButton).toHaveAttribute('aria-label', '禁用自动换行')
    expect(wrapButton).toHaveAttribute('title', '禁用自动换行')
    expect(screen.getByTestId('markdown-code-wrap-enabled-icon')).toBeInTheDocument()
    expect(scrollContainer).toHaveAttribute('data-wrap', 'true')
    expect(scrollContainer).toHaveClass('overflow-x-hidden')
    expect(code).toHaveStyle({
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    })

    await user.unhover(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    expect(wrapButton).toHaveAttribute('aria-label', '禁用自动换行')
    expect(scrollContainer).toHaveAttribute('data-wrap', 'true')
    expect(code).toHaveStyle({
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    })

    await user.click(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
    expect(wrapButton).toHaveAttribute('aria-label', '开启自动换行')
    expect(scrollContainer).toHaveAttribute('data-wrap', 'false')
    expect(code).toHaveStyle({
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      wordBreak: 'normal',
    })
  })

  test('keeps markdown line wrapping when the code block remounts', async () => {
    const user = userEvent.setup()
    const markdownContent = [
      '```markdown',
      'Persistent markdown wrap state after pointer leaves and the block remounts.',
      '```',
    ].join('\n')

    const { unmount } = render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: markdownContent,
        }}
      />
    )

    await user.click(screen.getByTestId('markdown-code-wrap-button'))

    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-wrap',
      'true'
    )

    unmount()

    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: markdownContent,
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-wrap-button')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-wrap',
      'true'
    )
  })
})
