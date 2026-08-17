import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test('uses document typography for every Markdown heading level', () => {
  render(
    <AssistantMarkdown
      content={[
        '# Heading 1',
        '## Heading 2',
        '### Heading 3',
        '#### Heading 4',
        '##### Heading 5',
        '###### Heading 6',
      ].join('\n\n')}
      variant="document"
    />
  )

  expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-heading-lg')
  expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-heading-md')
  expect(screen.getByRole('heading', { level: 3 })).toHaveClass('text-heading-sm')
  expect(screen.getByRole('heading', { level: 4 })).toHaveClass('text-lg')
  expect(screen.getByRole('heading', { level: 5 })).toHaveClass('text-base')
  expect(screen.getByRole('heading', { level: 6 })).toHaveClass('text-sm')
})
