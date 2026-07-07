import { describe, expect, test } from 'vitest'
import type { NormalizedRuntimeMessage } from '@/types/api'
import { notificationTextFromMessages } from './runtimeTaskNotificationContent'

function message(overrides: Partial<NormalizedRuntimeMessage>): NormalizedRuntimeMessage {
  return {
    id: overrides.id ?? 'message-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? '',
    ...overrides,
  }
}

describe('runtimeTaskNotificationContent', () => {
  test('uses the latest user prompt and following assistant reply', () => {
    const text = notificationTextFromMessages([
      message({ id: 'user-1', role: 'user', content: 'old question' }),
      message({ id: 'assistant-1', role: 'assistant', content: 'old reply' }),
      message({ id: 'user-2', role: 'user', content: ' fix the tray badge ' }),
      message({ id: 'assistant-2', role: 'assistant', content: 'Done, I updated the badge.' }),
    ])

    expect(text).toEqual({
      title: 'fix the tray badge',
      body: 'Done, I updated the badge.',
    })
  })

  test('falls back to assistant text blocks when message content is empty', () => {
    const text = notificationTextFromMessages([
      message({ id: 'user-1', role: 'user', content: 'summarize logs' }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        blocks: [
          { id: 'block-1', type: 'thinking', content: 'Checking logs.' },
          { id: 'block-2', type: 'text', content: 'The run completed successfully.' },
        ],
      }),
    ])

    expect(text).toEqual({
      title: 'summarize logs',
      body: 'The run completed successfully.',
    })
  })

  test('returns null when no user prompt is available', () => {
    expect(
      notificationTextFromMessages([
        message({ id: 'assistant-1', role: 'assistant', content: 'Done.' }),
      ])
    ).toBeNull()
  })
})
