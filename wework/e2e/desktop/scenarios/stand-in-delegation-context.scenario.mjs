import { createDesktopScenario as createInterface } from './stand-in-model-interface.scenario.mjs'
import { withExecutionContextAssertions } from '../modules/execution-context-assertions.mjs'

export function createDesktopScenario(options) {
  return withExecutionContextAssertions(createInterface(options), {
    marker: 'STAND_IN_MODEL_INTERFACE_WORK',
    expected: ['already-created delegated worker', 'host returns'],
  })
}
