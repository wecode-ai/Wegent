import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
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
