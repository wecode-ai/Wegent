import { copyTextToClipboard } from '@/lib/clipboard'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/styles/globals.css'
import type { ComponentProps } from 'react'
import { MarkdownCodeBlock as SharedMarkdownCodeBlock } from '@wegent/collaboration/markdown/MarkdownCodeBlock'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
import { highlightCode } from '../../../../packages/collaboration/src/markdown/highlightCode'
import { codeHighlightClient } from '../../../../packages/collaboration/src/markdown/codeHighlightClient'

class HighlightWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  terminated = false
  postMessage({ id, code, language }: { id: number; code: string; language: string }) {
    queueMicrotask(() => {
      if (!this.terminated)
        this.onmessage?.({ data: { id, result: highlightCode(code, language) } } as MessageEvent)
    })
  }
  terminate() {
    this.terminated = true
  }
}
vi.stubGlobal('Worker', HighlightWorker)

function MarkdownCodeBlock(props: ComponentProps<typeof SharedMarkdownCodeBlock>) {
  return (
    <MarkdownServicesProvider value={useDesktopMarkdownServices()}>
      <SharedMarkdownCodeBlock {...props} />
    </MarkdownServicesProvider>
  )
}

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

describe('MarkdownCodeBlock', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    trackMock.mockReset()
    vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined)
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
    expect(scrollContainer.querySelector('[data-syntax-token="keyword"]')).toHaveTextContent(
      'SELECT'
    )

    rerender(<MarkdownCodeBlock lang="sql">SELECT 1</MarkdownCodeBlock>)

    expect(scrollContainer.querySelector('pre')).toBe(pre)
    expect(scrollContainer.querySelector('code')).toBe(code)
    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true')
    expect(scrollContainer).toHaveClass('scrollbar-soft', 'overflow-x-auto')
    expect(scrollContainer).not.toHaveClass('scrollbar-none')
    expect(screen.getByTestId('markdown-code-horizontal-scrollbar')).not.toHaveAttribute('hidden')
    expect(scrollContainer.querySelector('[data-syntax-token="keyword"]')).toHaveTextContent(
      'SELECT'
    )
  })

  test('highlights completed code over the previous line limit', async () => {
    const code = Array.from({ length: 81 }, (_, index) => `-- ${index + 1}`).join('\n')

    render(<MarkdownCodeBlock lang="sql">{code}</MarkdownCodeBlock>)

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
    expect(scrollContainer.querySelectorAll('[data-syntax-token="comment"]')).toHaveLength(81)
    expect(scrollContainer.querySelector('code')).toHaveTextContent('-- 81')
  })

  test('highlights completed code over the previous character limit', async () => {
    const code = `-- ${'x'.repeat(2_000)}`

    render(<MarkdownCodeBlock lang="sql">{code}</MarkdownCodeBlock>)

    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
    expect(scrollContainer.querySelector('[data-syntax-token="comment"]')).toHaveTextContent(code)
    expect(scrollContainer.querySelector('code')).toHaveTextContent(code)
  })

  test('coalesces streaming updates and rejects results from a previous language', async () => {
    const replies: Array<(value: ReturnType<typeof highlightCode>) => void> = []
    const highlight = vi
      .spyOn(codeHighlightClient, 'highlight')
      .mockImplementation(() => new Promise(resolve => replies.push(resolve)))
    const { rerender } = render(
      <MarkdownCodeBlock lang="ts" isStreaming>
        const x = 1
      </MarkdownCodeBlock>
    )
    rerender(
      <MarkdownCodeBlock lang="ts" isStreaming>
        const x = 12
      </MarkdownCodeBlock>
    )
    rerender(
      <MarkdownCodeBlock lang="ts" isStreaming>
        const x = 123
      </MarkdownCodeBlock>
    )
    expect(highlight).toHaveBeenCalledTimes(1)
    await act(async () => replies.shift()!(highlightCode('const x = 1', 'typescript')))
    expect(highlight).toHaveBeenLastCalledWith('const x = 123', 'typescript')
    rerender(<MarkdownCodeBlock lang="plaintext">const x = 123</MarkdownCodeBlock>)
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-syntax-highlighted',
      'false'
    )
    await act(async () => replies.shift()!(highlightCode('const x = 123', 'typescript')))
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-syntax-highlighted',
      'false'
    )
    await act(async () => replies.shift()!(highlightCode('const x = 123', 'plaintext')))
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-syntax-highlighted',
      'true'
    )
    expect(
      screen.getByTestId('markdown-code-block').querySelector('[data-syntax-token="keyword"]')
    ).toBeNull()
    highlight.mockRestore()
  })

  test('preserves Unicode and line endings while escaping source HTML', async () => {
    const code = 'const 你好 = "<img src=x onerror=alert(1)>😀"\r\n// 末行'
    render(<MarkdownCodeBlock lang="ts">{code}</MarkdownCodeBlock>)
    const block = screen.getByTestId('markdown-code-block')
    await waitFor(() =>
      expect(block.querySelector('[data-syntax-token="comment"]')).toHaveTextContent('// 末行')
    )
    expect(block.querySelector('img')).toBeNull()
    expect(block.querySelector('code')?.textContent?.replaceAll('\r\n', '\n')).toBe(
      code.replaceAll('\r\n', '\n')
    )
    expect(block).toHaveClass('pierre-code-block')
    expect(block.querySelector('[data-pierre-code-theme]')?.textContent).toContain('--hls-keyword:')
  })
})
