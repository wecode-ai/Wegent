import { describe, expect, test } from 'vitest'
import { splitRuntimeUserMessage, visibleRuntimeUserMessage } from './runtime-user-message'

describe('runtime user message', () => {
  test('extracts visible input from attachment and application context wrappers', () => {
    const content = [
      '# Files mentioned by the user:',
      '',
      '## image.png: /tmp/image.png',
      '',
      '## My request for Codex:',
      '<application_context>',
      '[wework.terminal.current]',
      'terminal state',
      '</application_context>',
      '',
      'Fix the sidebar',
    ].join('\n')

    expect(splitRuntimeUserMessage(content)).toEqual({
      prefix: '# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n',
      request: 'Fix the sidebar',
    })
    expect(visibleRuntimeUserMessage(content)).toBe('Fix the sidebar')
  })

  test('removes application context without an attachment wrapper', () => {
    expect(
      visibleRuntimeUserMessage(
        '<application_context>\n[terminal]\nstate\n</application_context>\n\nContinue fixing'
      )
    ).toBe('Continue fixing')
  })

  test('removes the complete wrapper when referenced conversations contain nested contexts', () => {
    const referencedConversation = JSON.stringify([
      {
        role: 'user',
        content:
          '<application_context>\\n[source]\\nsource state\\n</application_context>\\n\\nOriginal question',
      },
    ])
    const content = [
      '<application_context>',
      '[referencedConversations]',
      referencedConversation,
      '</application_context>',
      '',
      'Continue with the referenced conversation',
    ].join('\n')

    expect(visibleRuntimeUserMessage(content)).toBe('Continue with the referenced conversation')
  })

  test('preserves malformed context instead of dropping user content', () => {
    expect(visibleRuntimeUserMessage('<application_context>\nuser text')).toBe(
      '<application_context>\nuser text'
    )
  })
})
