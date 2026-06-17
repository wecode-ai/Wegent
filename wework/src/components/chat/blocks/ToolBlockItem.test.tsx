import '@/i18n'

import { render, screen } from '@testing-library/react'
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
    expect(preview).toHaveTextContent('Latest visible thought')
    expect(screen.queryByText('First step. Latest visible thought')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thinking-toggle-button')).not.toBeInTheDocument()
  })

  test('renders completed thinking without per-block folding', () => {
    render(
      <ToolBlockItem
        block={{
          ...streamingThinkingBlock,
          status: 'done',
          content: 'I will inspect the repository before answering.',
        }}
      />
    )

    expect(screen.queryByTestId('thinking-toggle-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('thinking-detail')).toHaveTextContent(
      'I will inspect the repository before answering.'
    )
  })

  test('renders streaming process text directly in the timeline', () => {
    render(<ToolBlockItem block={streamingTextBlock} />)

    const block = screen.getByTestId('process-text-block')

    expect(block).toHaveAccessibleName('正在处理')
    expect(block).toHaveTextContent('Let me explore the repository structure.')
    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
  })

  test('renders completed process text without folding it', () => {
    render(<ToolBlockItem block={{ ...streamingTextBlock, status: 'done' }} />)

    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-text-block')).toHaveTextContent(
      'Let me explore the repository structure.'
    )
  })
})
