import { render, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

const formula = String.raw`\boxed{T_{0-17}=538{,}312\text{元}}`

describe('AssistantMarkdown math', () => {
  test.each([
    ['bracket block', `\\[\n${formula}\n\\]`, true],
    ['bracket on one line', `\\[${formula}\\]`, true],
    ['parentheses', `成本为 \\(${formula}\\)。`, false],
    ['single dollars', `成本为 $${formula}$。`, false],
    ['double dollars', `$$\n${formula}\n$$`, true],
    ['math fence', `\`\`\`math\n${formula}\n\`\`\``, true],
  ])('renders %s with accessible math instead of TeX source', async (_, content, display) => {
    const { container } = render(<AssistantMarkdown content={content as string} />)

    await waitFor(() => expect(container.querySelector('.katex math')).not.toBeNull())
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
    ).toBe(formula)
    expect(Boolean(container.querySelector('.katex-display'))).toBe(display)
    expect(container.querySelector('[data-testid="markdown-code-block"]')).not.toBeInTheDocument()
  })

  test('renders the reported aligned calculation and Chinese units', async () => {
    const content = String.raw`代入数据：

\[
\begin{aligned}
T_{0-17} &= 10{,}000+15{,}000 \\
&+3\times24{,}538 \\
&+3\times(24{,}538+12{,}000)
\end{aligned}
\]

最终为 \(680{,}312\text{元}\)。`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.katex math')).toHaveLength(2))
    expect(container.querySelector('.katex-display .mtable')).toBeInTheDocument()
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument()
    expect(container).toHaveTextContent('元')
  })

  test('preserves code examples, escaped delimiters, currencies and link destinations', () => {
    const content = String.raw`价格 $20 和 $30；预算 $100.00。

示例：\$x\$；\`\(x^2\)\`。

[查看](https://example.test/\(file\))

\`\`\`text
\[x^2\]
$x^2$
\`\`\``.replaceAll('\\`', '`')
    const { container } = render(<AssistantMarkdown content={content} />)

    expect(container.querySelector('.katex')).not.toBeInTheDocument()
    expect(container).toHaveTextContent('价格 $20 和 $30；预算 $100.00。')
    expect(container.querySelector('code')).toHaveTextContent('\\(x^2\\)')
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.test/(file)')
    expect(
      container.querySelector('[data-testid="markdown-code-scroll-container"]')
    ).toHaveTextContent('\\[x^2\\]')
  })

  test('completes a streamed formula and preserves it when streaming finishes', async () => {
    const { container, rerender } = render(
      <AssistantMarkdown content={String.raw`结果：\[\frac{1}{`} isStreaming />
    )
    const content = String.raw`结果：\[\frac{1}{2}\]`
    rerender(<AssistantMarkdown content={content} isStreaming />)

    await waitFor(() => expect(container.querySelector('.katex .mfrac')).toBeInTheDocument())
    rerender(<AssistantMarkdown content={content} />)
    await waitFor(() => expect(container.querySelectorAll('.katex math')).toHaveLength(1))
    expect(container.querySelector('.katex-error')).not.toBeInTheDocument()
  })

  test.each(['default', 'document', 'process', 'user'] as const)(
    'renders formulas in the %s surface',
    async variant => {
      const { container } = render(
        <AssistantMarkdown content={String.raw`\(x_1 + x_2\)`} variant={variant} />
      )
      await waitFor(() => expect(container.querySelectorAll('.katex math')).toHaveLength(1))
      expect(container.querySelector('annotation')?.textContent).toBe('x_1 + x_2')
    }
  )

  test('keeps display formulas inside their quote and list containers', async () => {
    const content = String.raw`> \[
> x_1 + x_2
> \]

- Calculation:

  \[
  \frac{1}{2}
  \]`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.katex math')).toHaveLength(2))
    expect(container.querySelector('blockquote .katex-display')).toBeInTheDocument()
    expect(container.querySelector('li .katex-display .mfrac')).toBeInTheDocument()
  })

  test('renders inline math in GFM tables and keeps escaped closers in TeX', async () => {
    const content = String.raw`| Formula | Value |
| --- | --- |
| \(a\\)b\) | $x + 1$ |`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelectorAll('td .katex math')).toHaveLength(2))
    expect(container.querySelector('annotation')?.textContent).toBe(String.raw`a\\)b`)
  })

  test.each([
    ['outer pipes', '| Formula | Value |\n| --- | --- |\n| Area | \\[\\pi r^2\\] |'],
    ['no outer pipes', 'Formula | Value\n--- | ---\nArea | \\[\\pi r^2\\]'],
    ['quoted table', '> | Formula | Value |\n> | --- | --- |\n> | Area | \\[\\pi r^2\\] |'],
  ])('preserves %s around display delimiters in table cells', async (_, content) => {
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelector('td .katex math')).not.toBeNull())
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    expect(container.querySelectorAll('tbody td')).toHaveLength(2)
    expect(container.querySelector('td annotation')?.textContent).toBe(String.raw`\pi r^2`)
    expect(container.querySelector('tbody')).toHaveTextContent('Area')
  })

  test.each([
    ['heading', '## Area \\[x_1\\]', 'h2'],
    ['emphasis', '**Area \\[x_1\\]**', 'strong'],
    ['link label', '[Area \\[x_1\\]](https://example.test)', 'a'],
  ])('keeps display delimiters inside the %s phrasing container', async (_, content, selector) => {
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelector(`${selector} .katex math`)).not.toBeNull())
    expect(container.querySelector(selector)).toHaveTextContent('Area')
    expect(container.querySelector('annotation')?.textContent).toBe('x_1')
    expect(container.querySelector('.katex-display')).not.toBeInTheDocument()
  })

  test('preserves nested containers around single-line display math', async () => {
    const content = String.raw`> - Result: \[x_1\] follows.

1. \[x_2\]`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelectorAll('li .katex-display')).toHaveLength(2))
    expect(container.querySelector('blockquote li')).toHaveTextContent('follows.')
    expect(container.querySelector('ol li .katex-display')).toBeInTheDocument()
  })

  test.each([' ', '\t', ' followed by text'])(
    'handles display formulas followed by %j without interrupting Markdown rendering',
    async suffix => {
      const content = `\\[\nx_1\n\\]${suffix}\n\nNext paragraph.`
      const { container } = render(<AssistantMarkdown content={content} />)

      await waitFor(() => expect(container.querySelectorAll('.katex-display math')).toHaveLength(1))
      expect(container.querySelector('annotation')?.textContent?.trim()).toBe('x_1')
      expect(container).toHaveTextContent('Next paragraph.')
      if (suffix.trim()) expect(container).toHaveTextContent(suffix.trim())
    }
  )

  test('keeps malformed math readable without throwing or consuming currency', async () => {
    const content = String.raw`$ spaced $ and $x $; $20 and $30.

Incomplete: \(x_1

Invalid: \(\frac{1}\)`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelector('.katex-error')).toBeInTheDocument())
    expect(container).toHaveTextContent('$ spaced $ and $x $; $20 and $30.')
    expect(container.querySelector('.katex-error')).toHaveTextContent(String.raw`\frac{1}`)
  })

  test('keeps unsupported TeX readable and does not enable trusted HTML commands', async () => {
    const content = String.raw`\(\unknowncommand{x}\) and \(\href{javascript:alert(1)}{click}\)`
    const { container } = render(<AssistantMarkdown content={content} />)

    await waitFor(() => expect(container.querySelectorAll('.katex math')).toHaveLength(2))
    expect(container).toHaveTextContent('\\unknowncommand{x}')
    expect(container.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument()
    expect(container.querySelector('script')).not.toBeInTheDocument()
  })
})
