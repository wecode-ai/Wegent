import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test('removes unsupported content-reference citations from assistant Markdown', () => {
  render(
    <AssistantMarkdown
      content={'First source. \uE200cite\uE202turn0search2\uE202turn0search8\uE201 Next sentence.'}
    />
  )

  expect(screen.getByText('First source. Next sentence.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('turn0search2')
  expect(document.body).not.toHaveTextContent('\uE200cite')
})

test('hides an unfinished citation marker while assistant Markdown is streaming', () => {
  render(<AssistantMarkdown content={'Visible answer. \uE200cite\uE202turn0search2'} isStreaming />)

  expect(screen.getByText('Visible answer.')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('turn0search2')
  expect(document.body).not.toHaveTextContent('\uE200cite')
})
