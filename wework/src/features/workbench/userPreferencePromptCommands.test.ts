import { describe, expect, test } from 'vitest'

import {
  appendUserPreferencePrompt,
  parseUserPreferencePromptCommand,
} from './userPreferencePromptCommands'

describe('user preference prompt commands', () => {
  test('parses append and settings commands', () => {
    expect(parseUserPreferencePromptCommand('/remember Keep replies concise.')).toEqual({
      action: 'append',
      value: 'Keep replies concise.',
    })
  })

  test.each(['', '   ', '/remember', '/remember    ', 'remember this'])(
    'rejects invalid input %s',
    input => {
      expect(parseUserPreferencePromptCommand(input)).toBeNull()
    }
  )

  test('appends a preference as a new line', () => {
    expect(appendUserPreferencePrompt('First', '  Second  ')).toBe('First\nSecond')
    expect(appendUserPreferencePrompt('', 'First')).toBe('First')
  })

  test('rejects an append over the limit', () => {
    expect(() => appendUserPreferencePrompt('', 'x'.repeat(4001))).toThrow(
      'User preference prompt must be at most 4000 characters'
    )
  })
})
