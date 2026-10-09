// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const collaborationTestIds = {
  root: "collaboration-root",
  projectList: "collaboration-project-list",
  createProject: "collaboration-project-create",
  createProjectDialog: "collaboration-project-create-dialog",
  createProjectConfirm: "collaboration-project-create-confirm",
  project: (id: string) => `collaboration-project-${id}`,
  board: "collaboration-board",
  createIssue: "collaboration-issue-create",
  createIssueDialog: "collaboration-issue-create-dialog",
  createIssueConfirm: "collaboration-issue-create-confirm",
  issue: (id: string) => `collaboration-issue-${id}`,
  issueDetail: "collaboration-issue-detail",
  issueArchiveDialog: "collaboration-issue-archive-dialog",
  issueArchiveCancel: "collaboration-issue-archive-cancel",
  issueArchiveConfirm: "collaboration-issue-archive-confirm",
  issueArchiveError: "collaboration-issue-archive-error",
  issueArchiveOpen: "collaboration-issue-archive-open",
  issueArchiveDrawer: "collaboration-issue-archive-drawer",
  issueArchiveDrawerClose: "collaboration-issue-archive-drawer-close",
  issueArchiveLoadMore: "collaboration-issue-archive-load-more",
  issueArchiveCompleted: "collaboration-issue-archive-completed",
  issueSave: "collaboration-issue-save",
  issueClose: "collaboration-issue-close",
  issueComment: "collaboration-issue-comment",
  issueCommentSubmit: "collaboration-issue-comment-submit",
  files: "collaboration-files",
  legacyInboxNotice: "legacy-inbox-notice",
} as const;
