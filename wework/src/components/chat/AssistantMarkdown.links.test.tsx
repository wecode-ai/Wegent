import { render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

test.each([
  'javascript:alert%281%29',
  'data:text/html,unsafe',
  'vbscript:msgbox%281%29',
  'java%73cript%3Aalert%281%29',
  'vbs%63ript%3Amsgbox%281%29',
])('keeps unsafe URL %s out of rendered links', href => {
  const renderLink = vi.fn()
  const { container } = render(
    <AssistantMarkdown content={`[unsafe](${href})`} renderLink={renderLink} />
  )

  expect(renderLink).not.toHaveBeenCalled()
  expect(container.querySelector('[href]')).toBeNull()
})

test('strips unsafe raw HTML links and event attributes before rendering', () => {
  const renderLink = vi.fn()
  const { container } = render(
    <AssistantMarkdown
      content={
        '<a href="java&#x09;script:alert(1)" onclick="alert(2)">unsafe</a><img src="javascript:alert(3)" onerror="alert(4)">'
      }
      renderLink={renderLink}
    />
  )

  expect(renderLink).not.toHaveBeenCalled()
  expect(container.querySelector('[href], [onclick], [onerror], script')).toBeNull()
})
