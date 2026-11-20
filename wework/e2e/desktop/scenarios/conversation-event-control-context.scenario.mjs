import { createDesktopScenario as createEventScenario } from './conversation-event-wakeup.scenario.mjs'

export function createDesktopScenario(options) {
  return createEventScenario(options, { controlContextOnly: true })
}
