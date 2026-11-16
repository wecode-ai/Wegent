import { createDesktopScenario as createRecovery } from './stand-in-assignment-recovery.scenario.mjs'

export function createDesktopScenario(options) {
  return createRecovery({ ...options, startupRecoveryOnly: true })
}
