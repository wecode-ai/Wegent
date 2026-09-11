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
  issueSave: "collaboration-issue-save",
  issueClose: "collaboration-issue-close",
  issueComment: "collaboration-issue-comment",
  issueCommentSubmit: "collaboration-issue-comment-submit",
  files: "collaboration-files",
  legacyInboxNotice: "legacy-inbox-notice",
} as const;
