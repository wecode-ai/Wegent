import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  AssistantMarkdown as SharedAssistantMarkdown,
  MarkdownServicesProvider,
  browserMarkdownServices,
} from '@wegent/collaboration/markdown'
import { AssistantMarkdown } from './AssistantMarkdown'

test('renders Windows drive-letter markdown links as file links instead of [blocked]', () => {
  const onOpenFile = vi.fn()
  render(
    <AssistantMarkdown content="[wegent](C:/projects/example-app/wegent)" onOpenFile={onOpenFile} />
  )

  const link = screen.getByTestId('assistant-markdown-link')
  expect(link).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()

  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledWith('C:/projects/example-app/wegent')
})

test('renders backslash Windows drive-letter markdown links as file links', () => {
  render(<AssistantMarkdown content="[wegent](C:\\projects\\example-app\\wegent)" />)

  expect(screen.getByTestId('assistant-markdown-link')).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()
})

test('opens external markdown links without navigating the current page', () => {
  const openExternalUrl = vi.fn().mockResolvedValue(true)
  const originalLocation = window.location.href
  render(
    <MarkdownServicesProvider value={{ ...browserMarkdownServices, openExternalUrl }}>
      <SharedAssistantMarkdown content="[docs](https://example.com/docs)" />
    </MarkdownServicesProvider>
  )

  const link = screen.getByTestId('assistant-markdown-link')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')

  fireEvent.click(link)
  expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
  expect(window.location.href).toBe(originalLocation)
})
