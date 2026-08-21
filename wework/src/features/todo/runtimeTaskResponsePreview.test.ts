import { describe, expect, it } from 'vitest'
import {
  finalAssistantMessagesPreview,
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
    ).toBe('第一行\n第二行\n第三行')
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
    ).toBe('完成修复\n测试通过')
  })
})
