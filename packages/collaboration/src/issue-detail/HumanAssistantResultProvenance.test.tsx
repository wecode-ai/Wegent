// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { assistantMessageProvenance } from './assistantMessageProvenance'
import { HumanAssistantResultProvenance } from './HumanAssistantResultProvenance'

describe('assistant message provenance', () => {
  it.each([
    'human_assistant_result',
    'assistant_request_receipt',
    'assistant_request_evidence',
  ])('retains AI attribution for shared %s messages', async (activityType) => {
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <HumanAssistantResultProvenance
            message={{
              messageId: 'receipt',
              sender: { type: 'user', id: '7', name: 'Ada' },
              metadata: {
                activity_type: activityType,
                provenance: {
                  origin: 'ai_generated',
                  publisher_user_id: 7,
                  confirmation_status: 'unconfirmed',
                  private_context: 'SECRET',
                },
              },
            }}
            translate={createCollaborationTranslator('en')}
          />,
        ),
      )
      expect(container.textContent).toContain('AI generated')
      expect(container.textContent).toContain('Ada')
      expect(container.textContent).toContain('Unconfirmed')
      expect(container.textContent).not.toContain('SECRET')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('does not infer trust from an assistant name or unrelated metadata', () => {
    expect(
      assistantMessageProvenance({
        activity_type: 'ordinary',
        provenance: { origin: 'ai_generated', publisher_user_id: 7 },
      }),
    ).toBeNull()
    expect(
      assistantMessageProvenance({
        activity_type: 'assistant_request_receipt',
        provenance: { publisher_user_id: 7 },
      }),
    ).toBeNull()
    expect(
      assistantMessageProvenance({
        activity_type: 'assistant_request_receipt',
        provenance: 'malformed',
      }),
    ).toBeNull()
  })
})
