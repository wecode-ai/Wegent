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

test('renders and updates an unfinished Mermaid fence while the model is streaming', async () => {
  const { container, rerender } = render(
    <AssistantMarkdown content={'```mermaid\ngraph LR\n  A[Start]'} isStreaming />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram-preview"]')).toHaveAttribute(
      'data-language',
      'mermaid'
    )
  })

  rerender(
    <AssistantMarkdown content={'```mermaid\ngraph LR\n  A[Start] --> B[Streaming]'} isStreaming />
  )

  await waitFor(() => {
    const preview = container.querySelector('[data-testid="diagram-preview"]')
    expect(preview).toHaveAttribute('data-language', 'mermaid')
    expect(preview).toHaveAttribute('data-code', 'graph LR\n  A[Start] --> B[Streaming]')
  })
})

test('renders an unfinished PlantUML fence while the model is streaming', async () => {
  const { container } = render(
    <AssistantMarkdown content={'```plantuml\n@startuml\nAlice -> Bob: Streaming'} isStreaming />
  )

  await waitFor(() => {
    expect(container.querySelector('[data-testid="diagram-preview"]')).toHaveAttribute(
      'data-language',
      'plantuml'
    )
  })
})
