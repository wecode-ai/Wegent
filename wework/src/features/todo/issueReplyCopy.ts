export const issueReplyCopy = {
  human: {
    label: 'workbench.task_activity_replying_to_human',
    placeholder: 'workbench.task_activity_discussion_reply_placeholder',
  },
  'stand-in': {
    label: 'workbench.task_activity_replying_to_stand_in',
    placeholder: 'workbench.task_activity_stand_in_reply_placeholder',
  },
  execution: {
    label: 'workbench.task_activity_replying_to',
    placeholder: 'workbench.task_activity_inline_placeholder',
  },
  discussion: {
    label: 'workbench.task_activity_replying_to_discussion',
    placeholder: 'workbench.task_activity_discussion_reply_placeholder',
  },
} as const

export type IssueReplyContextKind = keyof typeof issueReplyCopy
