import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test('renders Windows drive-letter markdown links as file links instead of [blocked]', () => {
  const onOpenFile = vi.fn()
  render(
    <AssistantMarkdown
      content="[wegent](D:/jiaqi62/Projects/Wegent-Internal/wegent)"
      onOpenFile={onOpenFile}
    />
  )

  const link = screen.getByTestId('assistant-markdown-link')
  expect(link).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()

  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledWith('D:/jiaqi62/Projects/Wegent-Internal/wegent')
})

test('renders backslash Windows drive-letter markdown links as file links', () => {
  render(<AssistantMarkdown content="[wegent](D:\\jiaqi62\\Projects\\Wegent-Internal\\wegent)" />)

  expect(screen.getByTestId('assistant-markdown-link')).toBeInTheDocument()
  expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument()
})
