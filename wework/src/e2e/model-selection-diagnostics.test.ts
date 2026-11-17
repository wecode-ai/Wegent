// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { logE2EModelSelection } from '../../e2e/desktop/modules/model-selection-diagnostics.mjs'

test('captures every model-trigger match separately with bounded identity-only details', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const buttons = Array.from({ length: 14 }, (_, index) => ({
    text: index === 0 ? 'Anthropic' : 'Luna',
    top: index * 30,
    left: 10,
    width: 120,
    height: 28,
    visible: index < 2,
    rendered: true,
    attributes: { 'data-model-provider-id': `provider-${index}`, 'aria-expanded': 'false' },
    privateField: 'PRIVATE_BUTTON_CONTENT',
  }))
  try {
    await logE2EModelSelection({
      control: {
        async command(action: string, selector: string, options?: { value: string }) {
          if (action === 'getWorkbenchDebugSnapshot') {
            return JSON.stringify({
              workbench: {
                composer: {
                  modelSelection: {
                    scopeFingerprint: 7,
                    renderedModelName: 'visible-model',
                    liveModelName: 'x'.repeat(300),
                    prompt: 'PRIVATE_PROMPT',
                    modelOptions: { api_key: 'SYNTHETIC_SECRET' },
                  },
                  currentInput: 'PRIVATE_INPUT',
                },
              },
            })
          }
          expect(action).toBe('getElementMetrics')
          const metricsOptions = JSON.parse(options!.value)
          if (selector === 'model-trigger') {
            expect(metricsOptions.includeText).toBe(true)
            return JSON.stringify(buttons)
          }
          expect(metricsOptions.includeText).toBeUndefined()
          return JSON.stringify([{ ...buttons[0], text: 'PRIVATE_PANE_CONTENT' }])
        },
      },
      context: 'fixture',
      composerSelector: 'pane',
      modelSelectorButton: 'model-trigger',
      modelIds: ['target'],
      labels: ['Anthropic'],
      selectedModelLabel: 'Anthropic\nLuna',
      selectedProviderId: 'provider-0',
    })

    const details = JSON.parse(log.mock.calls[0][1])
    expect(details).toMatchObject({ buttonCount: 14, visibleButtonCount: 2, paneCount: 1 })
    expect(details.buttons).toHaveLength(12)
    expect(details.buttons[0]).toMatchObject({ text: 'Anthropic', providerId: 'provider-0' })
    expect(details.buttons[1]).toMatchObject({ text: 'Luna', providerId: 'provider-1', top: 30 })
    expect(details.modelSelection.liveModelName).toHaveLength(160)
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE_|SYNTHETIC_SECRET|api_key|modelOptions/)
  } finally {
    log.mockRestore()
  }
})
