import { render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('./MarkdownDiagramPreview', () => ({
  MarkdownDiagramPreview: ({ code, language }: { code: string; language: string }) => (
    <div data-testid="diagram-preview" data-code={code} data-language={language} />
  ),
}))

test('routes Mermaid fenced code to the diagram preview', async () => {
  const { container } = render(
    <AssistantMarkdown content={'```mermaid\ngraph LR\n  A[Start] --> B[Done]\n```'} />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram-preview"]')).toHaveAttribute(
      'data-language',
      'mermaid'
    )
  })
  expect(container.querySelector('[data-testid="markdown-code-block"]')).not.toBeInTheDocument()
})

test('keeps an unfinished Mermaid fence as source while the model is streaming', async () => {
  const { container, rerender } = render(
    <AssistantMarkdown content={'```mermaid\ngraph LR\n  A[Start]'} isStreaming />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram-preview"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-testid="markdown-code-block"]')).toHaveTextContent(
      'A[Start]'
    )
    expect(
      container.querySelector('[data-testid="markdown-code-block-language"]')
    ).toHaveTextContent('mermaid')
  })

  rerender(
    <AssistantMarkdown
      content={'```mermaid\ngraph LR\n  A[Start] --> B[Streaming]\n```'}
      isStreaming
    />
  )

  await waitFor(() => {
    const preview = container.querySelector('[data-testid="diagram-preview"]')
    expect(preview).toHaveAttribute('data-language', 'mermaid')
    expect(preview).toHaveAttribute('data-code', 'graph LR\n  A[Start] --> B[Streaming]')
  })
})

test('distinguishes identical completed and unfinished Mermaid blocks while streaming', async () => {
  const diagram = 'graph LR\n  A[Start] --> B[Done]'
  const { container } = render(
    <AssistantMarkdown
      content={`\`\`\`mermaid\n${diagram}\n\`\`\`\n\n\`\`\`mermaid\n${diagram}`}
      isStreaming
    />
  )

  await waitFor(() => {
    expect(container.querySelectorAll('[data-testid="diagram-preview"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="markdown-code-block"]')).toHaveLength(1)
  })
  expect(container.querySelector('[data-testid="diagram-preview"]')).toHaveAttribute(
    'data-code',
    diagram
  )
  expect(
    container.querySelector('[data-testid="markdown-code-scroll-container"]')
  ).toHaveTextContent('A[Start] --> B[Done]')
})

test('preserves rendered paragraph identity across ordinary streaming updates', async () => {
  const { container, rerender } = render(
    <AssistantMarkdown content={'First paragraph.\n\nStable viewport anchor.'} isStreaming />
  )

  const anchor = await waitFor(() => {
    const element = Array.from(container.querySelectorAll('[data-scroll-anchor]')).find(node =>
      node.textContent?.includes('Stable viewport anchor.')
    )
    expect(element).toBeDefined()
    return element as HTMLElement
  })
  anchor.setAttribute('data-e2e-anchor-id', 'stable-streaming-anchor')

  rerender(
    <AssistantMarkdown
      content={'First paragraph.\n\nStable viewport anchor.\n\nLater streamed paragraph.'}
      isStreaming
    />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-e2e-anchor-id="stable-streaming-anchor"]')).toBe(anchor)
    expect(container).toHaveTextContent('Later streamed paragraph.')
  })
})

test('keeps an unfinished PlantUML fence as source while the model is streaming', async () => {
  const { container } = render(
    <AssistantMarkdown content={'```plantuml\n@startuml\nAlice -> Bob: Streaming'} isStreaming />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram-preview"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-testid="markdown-code-block"]')).toHaveTextContent(
      'Alice -> Bob: Streaming'
    )
  })
})
