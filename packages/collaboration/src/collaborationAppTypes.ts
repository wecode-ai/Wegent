// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type {
  CollaborationAssignment,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationProject,
} from './types'
import type { SharedWorkspaceApi, WorkspaceTaskBinding } from './ports/SharedWorkspaceApi'
import type { ProjectBoardIssueCardRenderContext } from './web-adapter/ProjectBoardAdapter'
import type { CollaborationLocale } from './i18n'

export interface CollaborationIssueDetailRenderContext {
  commentBoard?: import('./issue-detail/issueCommentActions').IssueCommentBoardContext
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  allIssues: CollaborationIssue[]
  assignments: CollaborationAssignment[]
  taskBindings: WorkspaceTaskBinding[]
  defaultAssistant?: CollaborationHostAdapter['defaultAssistant']
  onClose(): void
  onChange(issue: CollaborationIssue): void
  onRead(issue: CollaborationIssue): void
  onOpenRelatedIssue(issue: CollaborationIssue): void
  onAddChild?(): void
  onCreateTask?(): void
  /** Present for editable Issues when archiving is enabled. */
  onDelete?(): void
}

export interface CollaborationAppProps {
  /** Handling identity is independent of the project's permission identity. */
  participationUserId?: import('./issueParticipation').IssueParticipationViewer
  parentGroupingEnabled?: boolean
  api: SharedWorkspaceApi
  host: CollaborationHostAdapter
  initialProject?: CollaborationProject
  locale?: CollaborationLocale
  pollIntervalMs?: number
  createProjectRequestKey?: number
  refreshProjectRequestKey?: number
  showProjectBack?: boolean
  /** Enables Issue archive actions and the project archive box. */
  issueArchiveEnabled?: boolean
  normalizePastedFiles?(files: File[]): Promise<File[]>
  onProjectChange?(project: CollaborationProject): void
  /**
   * Host work that must succeed before the Issue is archived, such as stopping
   * an in-flight run on the device that owns it. A rejection aborts the archive
   * and its message is shown in the confirmation dialog.
   */
  onPrepareIssueArchive?(issue: CollaborationIssue): Promise<void>
  onCreateTask?(project: CollaborationProject, issue: CollaborationIssue): void
  renderIssueDetail?(context: CollaborationIssueDetailRenderContext): ReactNode
  isIssueRunning?(issue: CollaborationIssue, bindings: WorkspaceTaskBinding[]): boolean
  renderBoardIssueCard?(
    context: ProjectBoardIssueCardRenderContext & {
      onMarkRead(): Promise<void>
    }
  ): ReactNode
}
