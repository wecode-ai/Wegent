import { describe, expect, it } from 'vitest'
import {
  finalAssistantMessagesText,
  finalAssistantMessagesPreview,
  finalAssistantTranscriptText,
  finalAssistantTranscriptPreview,
} from './runtimeTaskResponsePreview'

describe('runtimeTaskResponsePreview', () => {
  it('uses the latest non-empty assistant response when a trailing placeholder is empty', () => {
    expect(
      finalAssistantMessagesPreview([
        {
          role: 'assistant',
          content: '第一行\n第二行\n第三行\n第四行',
        },
        {
          role: 'assistant',
          content: '',
        },
      ])
    ).toBe('第四行')
  })

  test('keeps the full final assistant response for expanded progress details', () => {
    const messages = [
      {
        role: 'assistant',
        content: '第一行\n第二行\n第三行\n第四行',
      },
    ]

    expect(finalAssistantMessagesText(messages)).toBe('第一行\n第二行\n第三行\n第四行')
    expect(
      finalAssistantTranscriptText({
        messages: [],
        turns: [
          {
            items: [
              {
                type: 'assistant_text',
                content: '第一行\n第二行\n第三行\n第四行',
              },
            ],
          },
        ],
      })
    ).toBe('第一行\n第二行\n第三行\n第四行')
  })

  it('falls back to canonical assistant turn items', () => {
    expect(
      finalAssistantTranscriptPreview({
        messages: [],
        turns: [
          {
            items: [
              {
                type: 'assistant_text',
                content: '完成修复\n测试通过',
              },
            ],
          },
        ],
      })
    ).toBe('测试通过')
  })

  it('uses the final response from the latest turn instead of an older message', () => {
    expect(
      finalAssistantTranscriptText({
        messages: [
          {
            role: 'assistant',
            content: '几轮之前的 final content',
          },
        ],
        turns: [
          {
            items: [
              {
                type: 'assistant_text',
                content: '旧一轮回复',
              },
            ],
          },
          {
            items: [
              {
                type: 'assistant_text',
                content: '最后一轮回复',
              },
            ],
          },
        ],
      })
    ).toBe('最后一轮回复')
  })

  it('does not fall back to an older response when the latest turn has no final content', () => {
    expect(
      finalAssistantTranscriptText({
        messages: [
          {
            role: 'assistant',
            content: '几轮之前的 final content',
          },
        ],
        turns: [
          {
            items: [
              {
                type: 'assistant_text',
                content: '旧一轮回复',
              },
            ],
          },
          {
            items: [
              {
                type: 'block',
              },
            ],
          },
        ],
      })
    ).toBeNull()
  })
})
