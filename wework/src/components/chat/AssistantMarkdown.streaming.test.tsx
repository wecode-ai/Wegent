import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/styles/globals.css'
import { AssistantMarkdown } from './AssistantMarkdown'

const runtimeMock = vi.hoisted(() => ({ electron: false }))

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isElectronRuntime: () => runtimeMock.electron,
}))

function fencedCode(lines: number, prefix = 'line'): string {
  return [
    '```ts',
    ...Array.from({ length: lines }, (_, index) => `${prefix}-${index + 1}`),
    '```',
  ].join('\n')
}

describe('AssistantMarkdown streaming stability', () => {
  afterEach(() => {
    runtimeMock.electron = false
    vi.unstubAllGlobals()
  })

  test('renders complete atomic transcripts when reopening a finished conversation', () => {
    runtimeMock.electron = true
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const content = Array.from(
      { length: 24 },
      (_, index) => `Persisted paragraph ${index + 1}. ${'Scrollable content '.repeat(12)}`
    ).join('\n\n')
    const first = render(<AssistantMarkdown content={content} />)
    expect(first.container.querySelectorAll('p')).toHaveLength(24)
    first.unmount()

    const reopened = render(<AssistantMarkdown content={content} />)

    expect(reopened.container.querySelectorAll('p')).toHaveLength(24)
    expect(reopened.container.querySelector('p:last-child')).toHaveTextContent(
      'Persisted paragraph 24.'
    )
    expect(reopened.container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
  })

  test('mounts a growing atomic chunk while bounded chunks remain windowed', () => {
    runtimeMock.electron = true
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const { container, rerender } = render(<AssistantMarkdown content="Short paragraph." />)
    expect(container.querySelector('[data-markdown-window-placeholder]')).not.toBeNull()

    rerender(<AssistantMarkdown content={'Long paragraph. '.repeat(400)} />)
    expect(container.querySelector('[data-markdown-window-placeholder]')).toBeNull()
    expect(container.querySelector('p')).toHaveTextContent('Long paragraph.')
  })

  test('keeps the code DOM mounted while more lines stream', async () => {
    const { rerender } = render(
      <AssistantMarkdown content={`Before code.\n\n${fencedCode(40)}`} isStreaming />
    )
    const codeBlock = screen.getByTestId('markdown-code-block')
    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    const code = codeBlock.querySelector('code')

    rerender(<AssistantMarkdown content={`Before code.\n\n${fencedCode(70)}`} isStreaming />)

    expect(screen.getByTestId('markdown-code-block')).toBe(codeBlock)
    expect(screen.getByTestId('markdown-code-scroll-container')).toBe(scrollContainer)
    expect(screen.getByTestId('markdown-code-block').querySelector('code')).toBe(code)
    expect(scrollContainer).toHaveTextContent('line-70')
    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))
  })

  test('keeps long highlighted markdown DOM mounted when streaming completes', async () => {
    const content = `Before code.\n\n${fencedCode(90)}`
    const { container, rerender } = render(<AssistantMarkdown content={content} isStreaming />)
    const paragraph = container.querySelector('p')
    const codeBlock = screen.getByTestId('markdown-code-block')
    const code = codeBlock.querySelector('code')
    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')

    await waitFor(() => expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true'))

    rerender(<AssistantMarkdown content={content} />)

    expect(container.querySelector('p')).toBe(paragraph)
    expect(screen.getByTestId('markdown-code-block')).toBe(codeBlock)
    expect(screen.getByTestId('markdown-code-block').querySelector('code')).toBe(code)
    expect(scrollContainer).toHaveAttribute('data-syntax-highlighted', 'true')
  })

  test('keeps code DOM mounted when growing content enters Markdown windowing', async () => {
    runtimeMock.electron = true
    const codeContent = [
      'Before code.',
      '',
      '```sql',
      ...Array.from(
        { length: 90 },
        (_, index) =>
          `SELECT ${index + 1} AS value_${index + 1}, '${'long-value-'.repeat(8)}' AS payload;`
      ),
      '```',
    ].join('\n')
    const windowedTail = Array.from(
      { length: 8 },
      (_, index) => `### Section ${index + 1}\n\n${'Windowed content. '.repeat(100)}`
    ).join('\n\n')
    const { container, rerender } = render(<AssistantMarkdown content={codeContent} isStreaming />)
    const codeBlock = screen.getByTestId('markdown-code-block')
    const code = codeBlock.querySelector('code')

    expect(container.querySelectorAll('[data-markdown-window-chunk]')).toHaveLength(1)

    rerender(<AssistantMarkdown content={`${codeContent}\n\n${windowedTail}`} />)

    await waitFor(() =>
      expect(container.querySelectorAll('[data-markdown-window-chunk]').length).toBeGreaterThan(1)
    )
    expect(screen.getByTestId('markdown-code-block')).toBe(codeBlock)
    expect(screen.getByTestId('markdown-code-block').querySelector('code')).toBe(code)
  })
})
