// @vitest-environment node

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
        if (action === 'waitFor' || action === 'ensureLocalModelCatalogReady') return ''
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
      'ensureLocalModelCatalogReady',
      'getText',
      'getAttribute',
    ])
  }
)

test('waits for startup reconciliation before reading even an already selected local model', async () => {
  let finish!: () => void
  const reconciliation = new Promise<void>(resolve => {
    finish = resolve
  })
  const command = vi.fn(async (action: string) => {
    if (action === 'waitFor') return ''
    if (action === 'ensureLocalModelCatalogReady') {
      await reconciliation
      return ''
    }
    if (action === 'getText') return DEFAULT_MODEL_LABEL
    if (action === 'getAttribute') return MODEL_PROVIDER_ID
    throw new Error(`Unexpected model picker action: ${action}`)
  })

  const selection = selectE2EModel({ command })
  await vi.waitFor(() =>
    expect(command.mock.calls.map(([action]) => action)).toEqual([
      'waitFor',
      'ensureLocalModelCatalogReady',
    ])
  )
  finish()
  await selection

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'waitFor',
    'ensureLocalModelCatalogReady',
    'getText',
    'getAttribute',
  ])
})

test('preserves catalog reconciliation failures without opening or retrying the picker', async () => {
  const failure = new Error('Catalog reconciliation failed')
  const command = vi.fn(async (action: string) => {
    if (action === 'waitFor') return ''
    if (action === 'ensureLocalModelCatalogReady') throw failure
    if (action === 'getText') return DEFAULT_MODEL_LABEL
    if (action === 'getAttribute') return MODEL_PROVIDER_ID
    throw new Error(`Unexpected model picker action: ${action}`)
  })

  await expect(selectE2EModel({ command })).rejects.toBe(failure)

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'waitFor',
    'ensureLocalModelCatalogReady',
  ])
})

test('does not reconcile the local catalog for a selected model without a local provider constraint', async () => {
  const command = vi.fn(async (action: string) => {
    if (action === 'waitFor' || action === 'getAttribute') return ''
    if (action === 'getText') return 'Cloud model'
    throw new Error(`Unexpected local catalog action: ${action}`)
  })

  await selectE2EModel({ command }, 'cloud-model', 'Cloud model')

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'waitFor',
    'getText',
    'getAttribute',
  ])
})
