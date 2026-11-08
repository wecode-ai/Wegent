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

test('renders composer reference examples literally inside inline and fenced code', () => {
  const reference = '[$Chat](wework-conversation://c)'
  const { container } = render(
    <AssistantMarkdown
      content={[`Inline: \`${reference}\``, '', '```markdown', reference, '```'].join('\n')}
    />
  )

  const codeTexts = Array.from(container.querySelectorAll('code')).map(node => node.textContent)
  expect(codeTexts.filter(text => text === reference)).toHaveLength(2)
  expect(codeTexts.some(text => text?.includes('\\$Chat'))).toBe(false)
})

test('renders references after inline code containing an HTML opener', () => {
  const issue = '[$#113 Issue](wework-issue://p/i)'
  const reference = '[$Chat](wework-conversation://c)'
  const { container } = render(
    <AssistantMarkdown
      content={['`<code>`', '', `${issue} ${reference}`].join('\n')}
      variant="user"
    />
  )

  const hrefs = Array.from(container.querySelectorAll('a')).map(link => link.getAttribute('href'))
  expect(hrefs).toEqual(['wework-issue://p/i', 'wework-conversation://c'])
})
