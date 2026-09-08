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

  test('keeps streaming code mounted while incrementally highlighting it', async () => {
    const { rerender } = render(
      <MarkdownCodeBlock lang="sql" isStreaming>
        SELECT 1
      </MarkdownCodeBlock>
    )

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    const pre = scrollContainer.querySelector('pre')
    const code = scrollContainer.querySelector('code')
    expect(scrollContainer).toHaveClass('scrollbar-none', 'overflow-x-hidden')
    expect(scrollContainer).not.toHaveClass('scrollbar-soft')
    expect(screen.getByTestId('markdown-code-horizontal-scrollbar')).toHaveAttribute('hidden')
    expect(pre).toHaveStyle({ overflowX: 'visible' })

    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
    expect(scrollContainer.querySelector('.hljs-keyword')).toHaveTextContent('SELECT')

    rerender(<MarkdownCodeBlock lang="sql">SELECT 1</MarkdownCodeBlock>)

    expect(scrollContainer.querySelector('pre')).toBe(pre)
    expect(scrollContainer.querySelector('code')).toBe(code)
    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true')
    expect(scrollContainer).toHaveClass('scrollbar-soft', 'overflow-x-auto')
    expect(scrollContainer).not.toHaveClass('scrollbar-none')
    expect(screen.getByTestId('markdown-code-horizontal-scrollbar')).not.toHaveAttribute('hidden')
    expect(scrollContainer.querySelector('.hljs-keyword')).toHaveTextContent('SELECT')
  })

  test('highlights completed code over the previous line limit', async () => {
    const code = Array.from({ length: 81 }, (_, index) => `-- ${index + 1}`).join('\n')

    render(<MarkdownCodeBlock lang="sql">{code}</MarkdownCodeBlock>)

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
    expect(scrollContainer.querySelectorAll('.hljs-comment')).toHaveLength(81)
    expect(scrollContainer.querySelector('code')).toHaveTextContent('-- 81')
  })

  test('highlights completed code over the previous character limit', async () => {
    const code = `-- ${'x'.repeat(2_000)}`

    render(<MarkdownCodeBlock lang="sql">{code}</MarkdownCodeBlock>)

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
    expect(scrollContainer.querySelector('.hljs-comment')).toHaveTextContent(code)
    expect(scrollContainer.querySelector('code')).toHaveTextContent(code)
  })
})
