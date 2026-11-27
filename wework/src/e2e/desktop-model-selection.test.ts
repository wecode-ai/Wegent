// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { selectE2EModel } from '../../e2e/desktop/modules/shared.mjs'
import { openExplicitModelMenu } from '../../e2e/desktop/scenarios/stand-in-model-execution.scenario.mjs'

test('waits for selection resolution before opening the explicit model panel', async () => {
  let panel = 'advanced'
  let selected = false
  let toggles = 0
  await openExplicitModelMenu(
    {
      async command(action: string, selector: string, options?: { visible?: boolean }) {
        if (action === 'getAttribute') return panel
        if (action === 'getElementCount') {
          assert.equal(options?.visible, true)
          assert.ok(selector.includes('[aria-checked="true"]'))
          if (!selected) {
            // The initial catalog resolves its model and enables the simple reasoning panel.
            selected = true
            panel = 'simple'
            return '0'
          }
          assert.equal(panel, 'advanced')
          return '1'
        }
        if (action === 'clickWhenEnabled' && selector.includes('model-advanced-toggle')) {
          assert.ok(selected, 'A transient empty advanced view is not a resolved model selection')
          assert.equal(panel, 'simple')
          toggles++
          panel = 'advanced'
        }
        return ''
      },
    },
    '[data-testid="model-selector-button"]',
    { requireSelection: true }
  )
  assert.equal(toggles, 1)
})

test('opens an advanced-only picker with no selection without toggling it', async () => {
  const trigger = '[data-testid="model-selector-button"]'
  await openExplicitModelMenu(
    {
      async command(action: string, selector: string) {
        if (action === 'clickWhenEnabled') assert.equal(selector, trigger)
        if (action === 'getAttribute') return 'advanced'
        if (action === 'getElementCount') {
          assert.equal(selector, '[data-testid="model-selector-menu"][data-panel="advanced"]')
          return '1'
        }
        return ''
      },
    },
    trigger
  )
})

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
              if (action === 'getElementMetrics') return '[]'
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
      assert.equal(
        calls.at(-1),
        `${!initiallyOpen && initiallySelected ? 'getElementMetrics' : 'getAttribute'}:${trigger}`
      )
      assert.equal(
        calls.filter(call => call === `getElementMetrics:${trigger}`).length,
        initiallyOpen ? 0 : 1
      )
      assert.ok(calls.includes(`getText:${trigger}`))
    })
  }
}

test('waits for the new conversation before reading its Anthropic model selection', async () => {
  const { verifyAnthropicEmptyResponseRecovery } =
    await import('../../e2e/desktop/modules/resilience-flows.mjs')
  const { ACTIVE_WORKBENCH_SELECTOR, CLOUD_MODEL_CASES } =
    await import('../../e2e/desktop/modules/shared.mjs')
  const model = CLOUD_MODEL_CASES.find(candidate => candidate.protocol === 'anthropic')!
  const composerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`
  const submitted = new Error('Reached model submission')
  let snapshots = 0
  let selected = false
  await assert.rejects(
    verifyAnthropicEmptyResponseRecovery({
      composerSelector,
      control: {
        setScenario() {},
        async awaitNextScenarioRequest() {},
        async command(action: string, selector: string) {
          if (action === 'getWorkbenchDebugSnapshot') {
            snapshots++
            const task = snapshots === 1 ? { taskId: 'previous-conversation' } : null
            return JSON.stringify({
              workbench: { currentRuntimeTask: task },
              pane: { currentRuntimeTask: task },
            })
          }
          if (action === 'snapshot') return JSON.stringify({ testIds: [] })
          if (action === 'getText') {
            assert.equal(snapshots, 2, 'The old composer must not satisfy new-chat readiness')
            assert.equal(
              selector,
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
            )
            selected = true
            return model.labels[0]
          }
          if (action === 'getAttribute') return ''
          if (action === 'getElementCount') return '0'
          if (action === 'fill') {
            assert.ok(selected, 'The active conversation must select its model before sending')
            throw submitted
          }
          return ''
        },
      },
    }),
    error => error === submitted
  )
})

test('explicitly chooses the protocol model even when the pending default label matches', async () => {
  const { verifyAnthropicEmptyResponseRecovery } =
    await import('../../e2e/desktop/modules/resilience-flows.mjs')
  const { ACTIVE_WORKBENCH_SELECTOR, CLOUD_MODEL_CASES } =
    await import('../../e2e/desktop/modules/shared.mjs')
  const model = CLOUD_MODEL_CASES.find(candidate => candidate.protocol === 'anthropic')!
  const option = `model-option-${model.optionIds[0]}`
  let open = false
  let explicitlySelected = false
  const submitted = new Error('Reached model submission')
  await assert.rejects(
    verifyAnthropicEmptyResponseRecovery({
      composerSelector: `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"]`,
      control: {
        setScenario() {},
        async awaitNextScenarioRequest() {},
        async command(action: string, selector: string, options?: { value?: string }) {
          if (action === 'getWorkbenchDebugSnapshot')
            return JSON.stringify({
              workbench: { currentRuntimeTask: null },
              pane: { currentRuntimeTask: null },
            })
          if (action === 'snapshot')
            return JSON.stringify({ testIds: open ? ['model-selector-menu', option] : [] })
          if (selector.endsWith('[data-testid="model-selector-button"]')) {
            if (action === 'getText') return model.modelId
            if (action === 'getAttribute') return ''
            if (action === 'clickWhenEnabled') open = true
          }
          if (action === 'getElementCount') return open ? '1' : '0'
          if (action === 'click' && selector.includes(option)) {
            assert.ok(open)
            explicitlySelected = true
          }
          if (action === 'getAttribute' && options?.value === 'aria-checked')
            return String(explicitlySelected)
          if (action === 'press') open = false
          if (action === 'fill') {
            assert.ok(
              explicitlySelected,
              'The matching draft default can still reconcile to another configured model'
            )
            throw submitted
          }
          return ''
        },
      },
    }),
    error => error === submitted
  )
})
