import { describe, expect, test } from 'vitest'
import { selectedModelExecutionFields } from './runtimeModelSelection'

describe('runtimeModelSelection', () => {
  test('keeps model options when the default model is selected', () => {
    expect(selectedModelExecutionFields(null, { collaborationMode: 'plan' })).toEqual({
      modelOptions: { collaborationMode: 'plan' },
    })
  })
})
