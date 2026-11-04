import { createDesktopScenario as createSources } from './connection-automations.scenario.mjs'

// The CI host runs the same verification after its project-source flow.
export function createDesktopScenario(options) {
  const sources = createSources(options)
  return { ...sources, verify: sources.verifyPersonal }
}
