import { waitForPreparationPhases } from '../../../electron/src/runtime/release-preparation-progress.mjs'

const PHASES = ['preparing', 'host', 'extracting', 'runtime', 'ready']

export function waitForUpdatePreparation(readProgress, options = {}) {
  return waitForPreparationPhases(readProgress, { ...options, phases: PHASES })
}
