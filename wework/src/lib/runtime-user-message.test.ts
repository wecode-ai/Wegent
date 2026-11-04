// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { visibleRuntimeUserMessage } from './runtime-user-message'

describe('runtime user message', () => {
  test('preserves malformed context instead of dropping user content', () => {
    expect(visibleRuntimeUserMessage('<application_context>\nuser text')).toBe(
      '<application_context>\nuser text'
    )
  })
})
