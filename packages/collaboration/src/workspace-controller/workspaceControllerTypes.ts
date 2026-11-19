// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { IssueReadProjection } from './issueReadState'
import type { ProjectBoardPosition } from '../project-board/useStandardCloudBoardController'
import type {
  SharedWorkspaceApi,
  WorkspaceBoardSnapshot,
  WorkspaceIssueAssignmentInput,
  WorkspaceIssueCreateInput,
  WorkspaceIssueUpdateInput,
  WorkspaceMyWorkItem,
  WorkspaceProjectCreateInput,
  WorkspaceProjectUpdateInput,
} from '../ports/SharedWorkspaceApi'
import type {
  CollaborationAssignment,
  CollaborationAttachment,
  CollaborationAgent,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationLocation,
  CollaborationMember,
  CollaborationProject,
} from '../types'

export interface CollaborationWorkspaceControllerState extends IssueReadProjection {
  projects: CollaborationProject[]
  myWork: WorkspaceMyWorkItem[]
  projectItems: Record<string, CollaborationIssue[]>
  projectMembers: Record<string, CollaborationMember[]>
  projectAgents: Record<string, CollaborationAgent[]>
  projectTaskBindings: Record<string, WorkspaceBoardSnapshot['taskBindings']>
  project: CollaborationProject | null
  issues: CollaborationIssue[]
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  taskBindings: WorkspaceBoardSnapshot['taskBindings']
  externalBoardParentId: string | null
  externalPageCursors: Record<string, string | null>
  externalPageLoading: Record<string, boolean>
  boardLoadRevision: number
  selectedIssue: CollaborationIssue | null
  attachments: CollaborationAttachment[]
  comments: CollaborationComment[]
  assignments: CollaborationAssignment[]
  executions: CollaborationExecution[]
  loading: boolean
  error: string | null
  errorSource: 'load' | 'save' | 'conflict' | null
}

export interface CollaborationWorkspaceControllerMessages {
  loadFailed: string
  saveFailed: string
  conflict: string
}

export interface CollaborationWorkspaceControllerOptions {
  api: SharedWorkspaceApi | null | undefined
  location: CollaborationLocation
  /** Seed a project already authorized and loaded by the parent navigation. */
  initialProject?: CollaborationProject
  messages: CollaborationWorkspaceControllerMessages
  myWorkEnabled?: boolean
  pollIntervalMs?: number
  loadProjectOnLocation?: boolean
  preloadHomeSnapshots?: boolean
  externalBoard?: {
    parentId: string | null
    pageSize: number
    eager: boolean
  }
  notify?(message: string, kind: 'success' | 'error'): void
}

export interface CollaborationWorkspaceControllerCommands {
  loadProjects(): Promise<void>
  loadProjectCatalog(options?: { isCurrent?(): boolean }): Promise<void>
  loadMyWork(): Promise<void>
  loadProject(
    projectId: string,
    showLoading?: boolean,
    options?: {
      isCurrent?(): boolean
      invalidate?: boolean
      loadSnapshot?: boolean
    }
  ): Promise<void>
  loadProjectSnapshot(
    projectId: string,
    options?: { invalidate?: boolean; throwOnError?: boolean }
  ): Promise<WorkspaceBoardSnapshot | null>
  loadMoreExternalColumn(status: string): Promise<void>
  getIssue(issueId: string): Promise<CollaborationIssue | null>
  loadSelectedIssue(issueId: string): Promise<CollaborationIssue | null>
  markIssueRead(issue: CollaborationIssue): Promise<CollaborationIssue | null>
  confirmIssueRead(issue: CollaborationIssue): CollaborationIssue
  clearProject(): void
  clearSelectedIssue(): void
  createProject(input: WorkspaceProjectCreateInput): Promise<CollaborationProject | null>
  updateProject(
    projectId: string,
    input: WorkspaceProjectUpdateInput
  ): Promise<CollaborationProject | null>
  archiveProject(projectId: string, version: number): Promise<boolean>
  createIssue(
    projectId: string,
    input: WorkspaceIssueCreateInput,
    options?: { throwOnError?: boolean }
  ): Promise<CollaborationIssue | null>
  updateIssue(
    issueId: string,
    input: WorkspaceIssueUpdateInput,
    /** The caller owns error presentation when true; position conflicts still reload. */
    options?: { throwOnError?: boolean }
  ): Promise<CollaborationIssue | null>
  assignIssue(
    projectId: string,
    issueId: string,
    input: WorkspaceIssueAssignmentInput
  ): Promise<CollaborationIssue | null>
  archiveIssue(issueId: string, options?: { throwOnError?: boolean }): Promise<boolean>
  refreshSelectedIssue(): Promise<void>
  refreshProjectAgents(projectId: string): Promise<void>
  replaceProject(project: CollaborationProject): void
  appendIssue(issue: CollaborationIssue): void
  replaceIssue(issue: CollaborationIssue): void
  replaceAttachments(issueId: string, attachments: CollaborationAttachment[]): void
  replaceComments(issueId: string, comments: CollaborationComment[]): void
  replaceAssignments(issueId: string, assignments: CollaborationAssignment[]): void
  reportError(message: string): void
}

export interface CollaborationWorkspaceController {
  state: CollaborationWorkspaceControllerState
  commands: CollaborationWorkspaceControllerCommands
}

export type CollaborationWorkspaceControllerAction =
  | { type: 'loading'; value: boolean }
  | {
      type: 'error'
      value: string | null
      source?: CollaborationWorkspaceControllerState['errorSource']
    }
  | {
      type: 'home-loaded'
      projects: CollaborationProject[]
      preserveSnapshotProjectIds: string[]
      projectItems: Record<string, CollaborationIssue[]>
      projectMembers: Record<string, CollaborationMember[]>
      projectAgents: Record<string, CollaborationAgent[]>
      projectTaskBindings: Record<string, WorkspaceBoardSnapshot['taskBindings']>
      myWork: WorkspaceMyWorkItem[]
    }
  | { type: 'project-catalog-loaded'; projects: CollaborationProject[] }
  | { type: 'project-metadata-loaded'; project: CollaborationProject }
  | {
      type: 'project-snapshot-loaded'
      projectId: string
      snapshot: WorkspaceBoardSnapshot
    }
  | { type: 'my-work-loaded'; items: WorkspaceMyWorkItem[] }
  | {
      type: 'project-loaded'
      project: CollaborationProject
      snapshot: WorkspaceBoardSnapshot
      externalBoard?: {
        parentId: string | null
        pageCursors: Record<string, string | null>
      }
    }
  | {
      type: 'external-column-loading'
      status: string
      value: boolean
    }
  | {
      type: 'external-column-appended'
      projectId: string
      status: string
      items: CollaborationIssue[]
      taskBindings: WorkspaceBoardSnapshot['taskBindings']
      nextCursor: string | null
    }
  | {
      type: 'issue-loaded'
      issue: CollaborationIssue
      attachments: CollaborationAttachment[]
      comments: CollaborationComment[]
      assignments: CollaborationAssignment[]
      executions: CollaborationExecution[]
      preserveAttachments?: boolean
      preserveComments?: boolean
      preserveAssignments?: boolean
    }
  | { type: 'issue-selected'; issue: CollaborationIssue }
  | { type: 'clear-project' }
  | { type: 'clear-selected-issue' }
  | { type: 'replace-project'; project: CollaborationProject }
  | {
      type: 'replace-project-agents'
      projectId: string
      agents: CollaborationAgent[]
    }
  | { type: 'remove-project'; projectId: string }
  | { type: 'replace-issues'; issues: CollaborationIssue[] }
  | { type: 'append-issue'; issue: CollaborationIssue }
  | {
      type: 'replace-issue'
      issue: CollaborationIssue
      position?: ProjectBoardPosition
    }
  | { type: 'issue-read'; issue: CollaborationIssue }
  | { type: 'remove-issue'; issueId: string }
  | { type: 'replace-attachments'; attachments: CollaborationAttachment[] }
  | { type: 'replace-comments'; comments: CollaborationComment[] }
  | {
      type: 'replace-assignments'
      assignments: CollaborationAssignment[]
    }
