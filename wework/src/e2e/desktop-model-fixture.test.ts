import { expect, test, vi } from 'vitest'
import {
  DEFAULT_MODEL_LABEL,
  MODEL_PROVIDER_ID,
  selectE2EModel,
} from '../../e2e/desktop/modules/shared.mjs'

test.each([
  ['GPT-5.6 Luna 轻度', DEFAULT_MODEL_LABEL],
  ['GPT 5.6 Luna', DEFAULT_MODEL_LABEL],
  ['GPT 5.6 Luna', [DEFAULT_MODEL_LABEL]],
])(
  'recognizes the selected runtime model label %s with expected labels %j',
  async (selectedLabel, expectedLabels) => {
    const command = vi.fn(
      async (action: string, _selector: string, options?: { value?: string }) => {
        if (action === 'waitFor') return ''
        if (action === 'getText') return selectedLabel
        if (action === 'getAttribute' && options?.value === 'data-model-provider-id') {
          return MODEL_PROVIDER_ID
        }
        throw new Error(`Unexpected picker action for the selected runtime model: ${action}`)
      }
    )

    await selectE2EModel({ command }, undefined, expectedLabels)

    expect(command.mock.calls.map(([action]) => action)).toEqual([
      'waitFor',
      'getText',
      'getAttribute',
    ])
  }
)
