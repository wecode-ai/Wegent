import '@/i18n'

import { fireEvent, render, screen } from '@testing-library/react'
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

  test('collapses completed thinking until the user expands it', () => {
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
    expect(
      screen.queryByText('I will inspect the repository before answering.')
    ).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('thinking-detail')).toHaveTextContent(
      'I will inspect the repository before answering.'
    )
  })

  test('renders streaming process text as a single live preview row', () => {
    render(<ToolBlockItem block={streamingTextBlock} />)

    const preview = screen.getByTestId('process-text-live-preview')

    expect(preview).toHaveTextContent('正在处理')
    expect(preview).toHaveTextContent('Let me explore the repository structure')
    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
  })

  test('collapses completed process text until the user expands it', () => {
    render(<ToolBlockItem block={{ ...streamingTextBlock, status: 'done' }} />)

    const toggle = screen.getByTestId('process-text-toggle-button')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('process-text-detail')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('process-text-detail')).toHaveTextContent(
      'Let me explore the repository structure.'
    )
  })
})
