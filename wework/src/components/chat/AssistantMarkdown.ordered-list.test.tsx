import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

test('preserves ordered-list starts when prose separates numbered items', () => {
  const { container } = render(
    <AssistantMarkdown
      content={[
        '1. First issue',
        '',
        'First explanation.',
        '',
        '2. Second issue',
        '',
        'Second explanation.',
        '',
        '3. Third issue',
      ].join('\n')}
    />
  )

  expect(
    Array.from(container.querySelectorAll('ol')).map(list => list.getAttribute('start'))
  ).toEqual([null, '2', '3'])
})
