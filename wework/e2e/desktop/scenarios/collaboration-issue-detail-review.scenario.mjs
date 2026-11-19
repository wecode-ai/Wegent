import { createDesktopScenario as createMentionScenario } from './collaboration-issue-comment-mention.scenario.mjs'
import { verifyIssueDetailReading } from '../modules/issue-detail-reading.mjs'

/** Extend the existing comment checkpoint without another bootstrap or build. */
export function createDesktopScenario(options) {
  const mentions = createMentionScenario(options)
  return {
    ...mentions,
    async verify(control) {
      await mentions.verify(control)
      await verifyIssueDetailReading(control, options)
    },
  }
}
