import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/styles/globals.css'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

describe('MarkdownCodeBlock', () => {
  beforeEach(() => {
    trackMock.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  test('tracks code block copy actions', async () => {
    render(<MarkdownCodeBlock lang="ts">const x = 1</MarkdownCodeBlock>)

    fireEvent.click(screen.getByTestId('markdown-code-copy-button'))

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('ai_output_action_completed', {
        action: 'copy',
        source: 'chat',
      })
    )
  })

  test('keeps Markdown table tokens inline', () => {
    render(
      <MarkdownCodeBlock lang="markdown">
        {'| name | type | port_list |\n| --- | --- | --- |\n| media | mysql | 5104 |'}
      </MarkdownCodeBlock>
    )

    const tableTokens = screen.getByTestId('markdown-code-block').querySelectorAll('.token.table')

    expect(tableTokens.length).toBeGreaterThan(0)
    tableTokens.forEach(token => {
      expect(token).toHaveStyle({ display: 'inline' })
    })
  })

  test('renders streaming code without syntax highlighting', () => {
    const { rerender } = render(
      <MarkdownCodeBlock lang="sql" isStreaming>
        SELECT 1
      </MarkdownCodeBlock>
    )

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'false')
    expect(scrollContainer.querySelector('.token')).not.toBeInTheDocument()

    rerender(<MarkdownCodeBlock lang="sql">SELECT 1</MarkdownCodeBlock>)

    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true')
    expect(scrollContainer.querySelector('.token')).toBeInTheDocument()
  })

  test('keeps long completed code as stable plain text', () => {
    const code = Array.from(
      { length: 110 },
      (_, index) => `SELECT ${index + 1} AS value_${index + 1};`
    ).join('\n')

    render(<MarkdownCodeBlock lang="sql">{code}</MarkdownCodeBlock>)

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'false')
    expect(scrollContainer.querySelector('.token')).not.toBeInTheDocument()
    const plainCode = scrollContainer.querySelector('code')
    expect(plainCode).toHaveTextContent('SELECT 110 AS value_110;')
    expect(plainCode?.parentElement).toHaveStyle({ color: '#abb2bf' })
  })
})
