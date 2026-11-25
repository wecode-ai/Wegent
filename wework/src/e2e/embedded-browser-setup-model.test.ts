// @vitest-environment node

import { expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../../e2e/desktop/scenarios/embedded-browser-agent.scenario.mjs'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  selectE2EModel,
} from '../../e2e/desktop/modules/shared.mjs'

vi.mock('../../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/setup-rendering-evidence.mjs', () => ({
  createSetupRenderingEvidence: () => vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal<typeof import('../../e2e/desktop/modules/shared.mjs')>()),
  selectE2EModel: vi.fn(),
}))

test('selects the Responses fixture model before submitting the browser setup task', async () => {
  const stopBeforeSubmission = new Error('Stop before submitting the setup task')
  const control = {
    url: 'http://desktop-e2e.test',
    setScenario: vi.fn(),
    command: vi.fn(async (action: string) => {
      if (action === 'fill') throw stopBeforeSubmission
    }),
  }
  const scenario = createDesktopScenario({
    executorHome: '/fixture/executor',
    resultDir: '/fixture/results',
    uiTimeoutMs: 1000,
    workspacePath: '/fixture/workspace',
  })

  await expect(scenario.verify(control)).rejects.toBe(stopBeforeSubmission)

  expect(selectE2EModel).toHaveBeenCalledExactlyOnceWith(
    control,
    DEFAULT_MODEL_ID,
    DEFAULT_MODEL_LABEL
  )
  const fill = control.command.mock.calls.findIndex(([action]) => action === 'fill')
  expect(vi.mocked(selectE2EModel).mock.invocationCallOrder[0]).toBeLessThan(
    control.command.mock.invocationCallOrder[fill]
  )
})
