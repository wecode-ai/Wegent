import { describe, expect, it } from 'vitest'
import type { RuntimeTranscriptResponse } from './runtime'
import { projectRuntimePaneTranscript } from './runtime-transcript-page'

const tail: RuntimeTranscriptResponse = {
  runtime: 'codex',
  workspacePath: '/workspace',
  messages: [],
  turns: [
    {
      id: 'long-turn',
      status: 'completed',
      items: [
        { id: 'answer', type: 'assistant_text', content: 'Complete answer' },
      ],
    },
  ],
  hasMoreBefore: true,
  beforeCursor: 'older-items',
}

describe('body-independent recovery receipts', () => {
  it('preserves explicit receipts while the user body and older accepted turns are absent', () => {
    const page = projectRuntimePaneTranscript({
      ...tail,
      acceptedClientUserMessageIds: ['long-turn-request', 'older-turn-request'],
    })
    expect(page.acceptedClientUserMessageIds).toEqual([
      'long-turn-request',
      'older-turn-request',
    ])
    expect(page.turns[0].items.map((item) => item.type)).toEqual([
      'assistant_text',
    ])
    expect(page.messages).toEqual([])
    expect(page.hasMoreBefore).toBe(true)
  })

  it('distinguishes an explicit empty receipt from a runtime that supplied no receipt', () => {
    expect(projectRuntimePaneTranscript(tail)).not.toHaveProperty(
      'acceptedClientUserMessageIds',
    )
    expect(
      projectRuntimePaneTranscript({
        ...tail,
        acceptedClientUserMessageIds: [],
      }),
    ).toHaveProperty('acceptedClientUserMessageIds', [])
  })
})
