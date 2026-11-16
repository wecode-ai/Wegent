import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test.each(['default', 'process', 'user'] as const)(
  'inherits UI body weight and keeps medium emphasis in %s messages',
  variant => {
    const { container } = render(
      <AssistantMarkdown
        content={[
          '# Heading 1',
          '## Heading 2',
          '### Heading 3',
          '#### Heading 4',
          '##### Heading 5',
          '###### Heading 6',
          'Normal body with **important detail**.',
          '| Name |\n| --- |\n| A |',
        ].join('\n\n')}
        variant={variant}
      />
    )

    expect(container.firstElementChild).not.toHaveClass('font-normal')
    const headings = screen.getAllByRole('heading')
    expect(headings).toHaveLength(6)
    headings.forEach(heading => expect(heading).toHaveClass('font-medium'))
    expect(screen.getByText('important detail')).toHaveClass('font-medium')
    expect(screen.getByRole('columnheader')).toHaveClass('font-medium')
    expect(container.querySelector('.font-semibold')).toBeNull()
  }
)

test('preserves stronger document emphasis without overriding its body typography', () => {
  const { container } = render(
    <AssistantMarkdown content={'## Document\n\n**Important detail**'} variant="document" />
  )

  expect(container.firstElementChild).not.toHaveClass('font-normal')
  expect(screen.getByRole('heading')).toHaveClass('font-semibold')
  expect(screen.getByText('Important detail')).toHaveClass('font-semibold')
})
