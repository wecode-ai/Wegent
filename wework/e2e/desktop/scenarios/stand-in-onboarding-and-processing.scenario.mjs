import { createDesktopScenario as createOnboarding } from './stand-in-onboarding-skip.scenario.mjs'
import { createDesktopScenario as createProcessing } from './stand-in-processing.scenario.mjs'

export function createDesktopScenario(options) {
  const onboarding = createOnboarding(options)
  const processing = createProcessing(options)
  return {
    ...processing,
    verifiesStandInOnboarding: true,
    async verify(control) {
      await onboarding.verify(control)
      await processing.verify(control)
    },
  }
}
