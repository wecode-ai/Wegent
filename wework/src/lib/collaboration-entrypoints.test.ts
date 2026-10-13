import { describe, expect, test } from 'vitest'
import * as root from '@wegent/collaboration'
import * as issueDetail from '@wegent/collaboration/issue-detail'
import * as issueEditor from '@wegent/collaboration/SharedIssueDetailEditor'
import * as myWork from '@wegent/collaboration/my-work/model'
import * as board from '@wegent/collaboration/board'
import * as priority from '@wegent/collaboration/issue-card/priorityBadgeClasses'
import * as i18n from '@wegent/collaboration/i18n'

describe('collaboration public entry points', () => {
  test('retains component identity between existing root imports and focused issue entry points', () => {
    // Shared component identity must survive callers using both public entry points.
    for (const name of [
      'RuntimeExecutionConversation',
      'ComposerAttachmentBadges',
      'IssueStatusHistoryList',
      'IssueAssignmentHistoryList',
      'IssueActivityFeed',
      'IssueActivityThread',
      'IssueThreadReplyComposer',
      'IssueMainCommentComposer',
      'IssueChatMessage',
    ] as const) {
      expect(issueDetail[name]).toBe(root[name])
    }
    expect(issueEditor.TodoEditor).toBe(root.TodoEditor)
    expect(issueEditor.SharedIssueDetailEditor).toBe(root.SharedIssueDetailEditor)
  })

  test('shares existing models, utilities, and configuration with focused entry points', () => {
    for (const name of [
      'createSharedIssueDetailPort',
      'formatIssueAttachmentSize',
      'issueTaskSummaryForMessage',
      'useIssueMentionCandidates',
      'groupIssueActivityThreads',
      'groupIssueTimelineThreads',
      'compareIssueTimestamps',
      'issueThreadActivityTimestamp',
      'formatIssueTimestamp',
      'managerActivityPresentation',
      'executionDisplayStatus',
      'isExecutionActive',
      'readTextAttachmentMetadata',
      'isImageAttachment',
    ] as const) {
      expect(issueDetail[name]).toBe(root[name])
    }
    expect(myWork.isLoopItemExecutionActive).toBe(root.isLoopItemExecutionActive)
    expect(myWork.isMyWorkExecutionActive).toBe(root.isMyWorkExecutionActive)
    expect(myWork.myWorkGroupOf).toBe(root.myWorkGroupOf)
    expect(board.reorderLaneItems).toBe(root.reorderLaneItems)
    expect(priority.collaborationIssueCardPriorityClasses).toBe(
      root.collaborationIssueCardPriorityClasses
    )
    expect(i18n.createCollaborationTranslator).toBe(root.createCollaborationTranslator)
  })
})
