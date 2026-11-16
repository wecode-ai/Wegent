import { createDesktopScenario as createReview } from './stand-in-profile-with-review.scenario.mjs'
import { withExecutionContextAssertions } from '../modules/execution-context-assertions.mjs'

export function createDesktopScenario(options) {
  return withExecutionContextAssertions(createReview(options), {
    marker: 'WEEKLY_MONDAY_USER_STORY',
    workerContext: 'The host fixes the read window',
    expected: ['already started', 'Do not ask for a new trigger time'],
  })
}
