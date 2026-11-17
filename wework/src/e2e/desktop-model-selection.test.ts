// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { selectE2EModel } from '../../e2e/desktop/modules/shared.mjs'

for (const initiallyOpen of [true, false]) {
  for (const initiallySelected of [true, false]) {
    test(`selects a model with the picker initially ${initiallyOpen ? 'open' : 'closed'} and target ${initiallySelected ? 'selected' : 'unselected'}`, async () => {
      let open = initiallyOpen
      let selected = initiallySelected
      let selections = 0
      const trigger = '[data-testid="model-selector-button"]'
      const option = 'model-option-fixture-target'
      const calls: string[] = []
      await selectE2EModel(
        {
          async command(action: string, selector: string, options?: { value?: string }) {
            calls.push(`${action}:${selector}`)
            if (selector === trigger) {
              assert.equal(open, false, 'The modal picker isolates its background trigger')
              if (action === 'getText') return selected ? 'Target model' : 'Source model'
              if (action === 'getAttribute') return 'fixture-provider'
              if (action === 'hover') open = true
              return ''
            }
            if (action === 'snapshot') {
              return JSON.stringify({ testIds: open ? ['model-selector-menu', option] : [] })
            }
            if (action === 'getElementCount') return open ? '1' : '0'
            if (action === 'click') {
              assert.ok(open)
              assert.ok(selector.includes(option))
              selected = true
              selections += 1
            }
            if (action === 'getAttribute' && options?.value === 'aria-checked') {
              return String(selected)
            }
            if (action === 'press') {
              assert.ok(selected, 'The option must be selected before dismissing the picker')
              open = false
            }
            return ''
          },
        },
        'fixture-target',
        'Target model',
        '',
        'fixture-provider'
      )
      assert.ok(selected)
      assert.equal(selections, initiallyOpen || !initiallySelected ? 1 : 0)
      assert.equal(open, false)
      assert.equal(calls.at(-1), `getAttribute:${trigger}`)
      assert.ok(calls.includes(`getText:${trigger}`))
    })
  }
}
