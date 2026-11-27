import {
  handleBoundReviewRequest,
  verifyStandInTeamBinding,
} from '../modules/verify-stand-in-team-binding.mjs'
import { createDesktopScenario as createReview } from './stand-in-profile-with-review.scenario.mjs'
import { createDesktopScenario as createSharedSettings } from './stand-in-shared-settings.scenario.mjs'
import { withScheduleUpdate } from '../modules/stand-in-schedule-update.mjs'
import { withExecutionContextAssertions } from '../modules/execution-context-assertions.mjs'

export function createDesktopScenario(options) {
  const scheduledContext = withExecutionContextAssertions(
    withScheduleUpdate(createReview(options), options),
    {
      marker: 'WEEKLY_MONDAY_USER_STORY',
      workerContext: 'The host fixes the read window',
      expected: ['already started', 'Do not ask for a new trigger time'],
    }
  )
  const sharedSettings = createSharedSettings(options)
  return {
    ...scheduledContext,
    async handleHttp(req, res, url) {
      return (
        (await handleBoundReviewRequest(req, res, url)) ||
        scheduledContext.handleHttp(req, res, url)
      )
    },
    async verify(control) {
      await scheduledContext.verify(control)
      await sharedSettings.verify(control)
      await verifyStandInTeamBinding(control, options)
    },
  }
}
