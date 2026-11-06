import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

describe('AssistantMarkdown CJK emphasis', () => {
  test.each(['default', 'document', 'process', 'user'] as const)(
    'renders the meeting summary as emphasis in the %s surface',
    variant => {
      const { container } = render(
        <AssistantMarkdown content="**今晚没有会议。**明天14点有用户关系周会。" variant={variant} />
      )
      expect(container.querySelector('strong')?.textContent?.replaceAll('\u200B', '')).toBe(
        '今晚没有会议。'
      )
      expect(container.textContent).not.toContain('**')
      expect(container.textContent).toContain('明天14点有用户关系周会。')
    }
  )

  test('preserves literal Markdown in inline code beside the formatted summary', () => {
    const { container } = render(
      <AssistantMarkdown content={'**今晚没有会议。**明天再准备。`**示例。**不要改`'} />
    )
    expect(container.querySelector('strong')).not.toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('**示例。**不要改')
  })
})
