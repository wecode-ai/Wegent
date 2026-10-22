import { expect, test, vi } from 'vitest'
import { MODEL_PROVIDER_ID, selectE2EModel } from '../../e2e/desktop/modules/shared.mjs'

test('recognizes the selected runtime model label without reopening the picker', async () => {
  const command = vi.fn(async (action: string, _selector: string, options?: { value?: string }) => {
    if (action === 'waitFor') return ''
    if (action === 'getText') return 'GPT-5.6 Luna 轻度'
    if (action === 'getAttribute' && options?.value === 'data-model-provider-id') {
      return MODEL_PROVIDER_ID
    }
    throw new Error(`Unexpected picker action for the selected runtime model: ${action}`)
  })

  await selectE2EModel({ command })

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'waitFor',
    'getText',
    'getAttribute',
  ])
})
