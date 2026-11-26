import { BrowserTaskDrafts } from './issue-detail/BrowserTaskDrafts'
import type { BoardIssueCreateDefaults } from './project-board/projectBoardViews'
import { isIssueVersionConflict } from './issue-detail/issueVersionConflict'
import { RuntimeConversationScope } from './conversation/RuntimeConversationScope'
import { IssueTaskConversation } from './issue-detail/IssueTaskConversation'
import type { SharedIssueDetailTaskBinding } from './issue-detail/createSharedIssueDetailPort'
import type { RuntimeExecutionTarget } from './issue-detail/runtimeExecutionTarget'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { collaborationTestIds } from './testIds'
import { useMemo, useState, type ReactNode } from 'react'

import {
  collaborationMessages,
  createCollaborationTranslator,
  type CollaborationTranslate,
} from './i18n'
import {
  SharedIssueDetailEditor,
  type SharedEditorIssue,
  type SharedEditorProject,
} from './SharedIssueDetailEditor'
import { createSharedIssueDetailPort } from './issue-detail'
import { IssueActivityPanel } from './issue-detail'
import { IssueMarkdownProvider } from './issue-detail/IssueMarkdownProvider'
import { dueDateTimeLocalFromSource, dueDateTimeLocalToSource } from './issue-detail/dateTime'
import { getCollaborationIssueActionPermissions } from './permissions'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import type { ProjectExecutionEnvironmentReadinessKind } from './execution-environment/issueEnvironmentReadiness'
import { IssueExecutionDetails } from './issue-detail/IssueExecutionDetails'
import { IssueConversationDrawers } from './issue-detail/IssueConversationDrawers'
import { BrowserAttachmentPreview } from './web-adapter/BrowserAttachmentPreview'
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationDefaultAssistant,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
} from './types'

type Messages = (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en']

interface IssueDetailProps {
  embedded?: boolean
  taskRequest?: { key: string; binding: SharedIssueDetailTaskBinding }
  headerActions?: ReactNode
  panelExpansion?: { expanded: boolean; onChange(expanded: boolean): void; testId: string }
  onOpenRelatedIssue?(issue: CollaborationIssue): void
  commentBoard?: import('./issue-detail/issueCommentActions').IssueCommentBoardContext
  api: Pick<
    SharedWorkspaceApi,
    | 'activity'
    | 'runtime'
    | 'issues'
    | 'attachments'
    | 'comments'
    | 'assignments'
    | 'members'
    | 'agents'
    | 'workspaces'
    | 'collaborators'
    | 'taskBindings'
    | 'deliveries'
    | 'automations'
  >
  project?: CollaborationProject
  issue: CollaborationIssue
  allIssues: CollaborationIssue[]
  comments: CollaborationComment[]
  assignments?: CollaborationAssignment[]
  executions?: CollaborationExecution[]
  members?: CollaborationMember[]
  agents?: CollaborationAgent[]
  defaultAssistant?: CollaborationDefaultAssistant
  messages: Messages
  translate?: CollaborationTranslate
  normalizePastedFiles?(files: File[]): Promise<File[]>
  onClose(): void
  /** Present only when the host enables this Issue lifecycle action. */
  onDelete?(): void
  onChange(issue: CollaborationIssue): void
  onRead(issue: CollaborationIssue): void
  onCommentsChange(comments: CollaborationComment[]): void
  onAssignmentsChange?(assignments: CollaborationAssignment[]): void
  onCreateTask?(): void
  onConflict(): Promise<void>
  onError(): void
}

interface IssueCreateProps {
  defaults?: BoardIssueCreateDefaults
  api: IssueDetailProps['api']
  project: CollaborationProject
  allIssues: CollaborationIssue[]
  messages: Messages
  translate?: CollaborationTranslate
  environmentNotice?: ReactNode
  environmentReadiness?: ProjectExecutionEnvironmentReadinessKind
  normalizePastedFiles?(files: File[]): Promise<File[]>
  onClose(): void
  onCreated(issue: CollaborationIssue): void | Promise<void>
  onError(): void
}

const browserDueDateExtensions = {
  dueDateInputType: 'datetime-local' as const,
  startDateFromSource: dueDateTimeLocalFromSource,
  startDateToSource: dueDateTimeLocalToSource,
  dueDateFromSource: dueDateTimeLocalFromSource,
  dueDateToSource: dueDateTimeLocalToSource,
}

export function saveBrowserIssueAttachment(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
  return Promise.resolve()
}

export function IssueCreate({
  defaults,
  api,
  project,
  allIssues,
  messages,
  translate,
  environmentNotice,
  environmentReadiness,
  normalizePastedFiles,
  onClose,
  onCreated,
  onError,
}: IssueCreateProps) {
  const port = useMemo(() => createSharedIssueDetailPort(api, saveBrowserIssueAttachment), [api])
  const editorTranslate =
    translate ??
    createCollaborationTranslator(messages === collaborationMessages.en ? 'en' : 'zh-CN')
  return (
    <div
      data-testid={collaborationTestIds.createIssueDialog}
      data-execution-environment-readiness={environmentReadiness}
    >
      <SharedIssueDetailEditor
        port={port}
        mode="create"
        project={project as SharedEditorProject}
        allItems={allIssues as SharedEditorIssue[]}
        initialParent={defaults?.parent ?? null}
        initialStatus={defaults?.status ?? project.board_config?.statuses?.[0]?.id ?? 'inbox'}
        initialTags={defaults?.tags}
        initialMilestoneId={defaults?.milestoneId}
        draftScope={defaults?.draftScope}
        onClose={onClose}
        onCreated={onCreated}
        onCreateError={() => {
          onError()
          return false
        }}
        translate={editorTranslate}
        extensions={{
          ...browserDueDateExtensions,
          ...(normalizePastedFiles ? { normalizePastedFiles } : {}),
          ...(environmentNotice ? { renderCreateOptions: () => environmentNotice } : {}),
        }}
      />
    </div>
  )
}

export function IssueDetail(props: IssueDetailProps) {
  return props.api.runtime ? (
    <BrowserTaskDrafts runtime={props.api.runtime}>
      <RuntimeConversationScope key={props.issue.id} runtime={props.api.runtime}>
        <BrowserIssueDetail key={props.issue.id} {...props} />
      </RuntimeConversationScope>
    </BrowserTaskDrafts>
  ) : (
    <BrowserIssueDetail key={props.issue.id} {...props} />
  )
}

function BrowserIssueDetail({
  embedded,
  taskRequest,
  headerActions,
  panelExpansion,
  onOpenRelatedIssue,
  commentBoard,
  api,
  project,
  issue,
  allIssues,
  comments,
  assignments = [],
  executions = [],
  members = [],
  agents = [],
  defaultAssistant,
  messages,
  translate,
  normalizePastedFiles,
  onClose,
  onDelete,
  onChange,
  onRead,
  onCommentsChange,
  onCreateTask,
  onConflict,
  onError,
}: IssueDetailProps) {
  const [attachmentPreview, setAttachmentPreview] = useState<{
    issueId: string
    attachmentId: string
    filename: string
  } | null>(null)
  const [conversationSelection, setConversationSelection] = useState<{
    issueId: string
    binding: SharedIssueDetailTaskBinding
  } | null>(null)
  const [handledTaskRequest, setHandledTaskRequest] = useState<string>()
  if (taskRequest && handledTaskRequest !== taskRequest.key) {
    setHandledTaskRequest(taskRequest.key)
    setConversationSelection({ issueId: issue.id, binding: taskRequest.binding })
  }
  const selectedConversation =
    conversationSelection?.issueId === issue.id ? conversationSelection.binding : null
  const closeConversation = () => setConversationSelection(null)
  const [selection, setSelection] = useState<{
    issueId: string
    target: RuntimeExecutionTarget
  } | null>(null)
  const selectedExecution = selection?.issueId === issue.id ? selection.target : null
  const closeExecution = () => setSelection(null)
  const permissions = project
    ? getCollaborationIssueActionPermissions(project, issue)
    : {
        canEdit: issue.can_edit === true,
        canComment: issue.invited_only === true,
        canAssign: issue.invited_only === true,
        canStartWork: false,
      }
  const port = useMemo(() => createSharedIssueDetailPort(api, saveBrowserIssueAttachment), [api])
  const editorTranslate =
    translate ??
    createCollaborationTranslator(messages === collaborationMessages.en ? 'en' : 'zh-CN')
  const currentAssignment =
    assignments
      .filter(assignment => assignment.status === 'active')
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      .at(-1) ?? null

  return (
    <>
      <IssueConversationDrawers
        embedded={embedded}
        label={editorTranslate('todo.issue_details', '任务详情')}
        conversation={
          selectedConversation && api.runtime ? (
            <IssueTaskConversation
              projectStore={project?.project_store ?? 'backend'}
              key={selectedConversation.id}
              binding={selectedConversation}
              issueId={issue.id}
              runtime={api.runtime}
              translate={editorTranslate}
              onClose={closeConversation}
            />
          ) : null
        }
        onCloseConversation={closeConversation}
        onClose={selectedExecution ? closeExecution : onClose}
      >
        {closeDrawers => (
          <SharedIssueDetailEditor
            port={port}
            mode="edit"
            commentBoard={commentBoard}
            item={issue as SharedEditorIssue}
            taskRefreshKey={issue.version}
            editable={permissions.canEdit}
            project={project as SharedEditorProject}
            allItems={allIssues as SharedEditorIssue[]}
            onClose={closeDrawers}
            onEscape={
              selectedExecution
                ? closeExecution
                : selectedConversation
                  ? closeConversation
                  : closeDrawers
            }
            onDelete={onDelete}
            deleteLabel={editorTranslate('todo.archive_issue', '归档任务')}
            onUpdated={updated => onChange(updated)}
            presentation="workspace-panel"
            workspacePanelFill
            readFirst
            showPanelControls
            headerActions={headerActions}
            panelExpansion={panelExpansion}
            onOpenChildTask={onOpenRelatedIssue}
            onOpenRelatedIssue={onOpenRelatedIssue}
            showAssignee
            canAssign={permissions.canAssign}
            currentAssignment={currentAssignment}
            canStartWork={permissions.canStartWork}
            defaultAssistant={defaultAssistant}
            onCreateTask={onCreateTask}
            translate={editorTranslate}
            extensions={{
              ...browserDueDateExtensions,
              ...(normalizePastedFiles ? { normalizePastedFiles } : {}),
              onSaveError: error => {
                if (isIssueVersionConflict(error)) void onConflict()
                else onError()
              },
              openAttachment: async (attachmentId, filename) => {
                setAttachmentPreview({
                  issueId: issue.id,
                  attachmentId,
                  filename,
                })
              },
              renderActivity: ({ tasks, commentAssignment, commentActions }) => (
                <IssueActivityPanel
                  commentActions={commentActions}
                  commentAssignment={commentAssignment}
                  api={api}
                  issue={issue}
                  project={project}
                  onTaskUpdated={onChange}
                  onTaskRead={onRead}
                  members={members}
                  agents={agents}
                  assignments={assignments}
                  comments={comments}
                  executions={executions}
                  taskBindings={tasks}
                  onOpenTaskConversation={
                    api.runtime
                      ? binding =>
                          setConversationSelection({
                            issueId: issue.id,
                            binding,
                          })
                      : undefined
                  }
                  onOpenExecution={
                    api.runtime ? target => setSelection({ issueId: issue.id, target }) : undefined
                  }
                  onOpenAttachment={(id, filename) => {
                    setAttachmentPreview({
                      issueId: issue.id,
                      attachmentId: id,
                      filename,
                    })
                  }}
                  canComment={permissions.canComment}
                  canAttach={permissions.canEdit}
                  translate={editorTranslate}
                  onCommentsChange={onCommentsChange}
                  onError={onError}
                />
              ),
            }}
          />
        )}
      </IssueConversationDrawers>
      {attachmentPreview?.issueId === issue.id ? (
        <IssueMarkdownProvider
          attachments={api.attachments}
          issueId={issue.id}
          projectId={issue.cloud_project_id}
        >
          <BrowserAttachmentPreview
            key={`${issue.id}:${attachmentPreview.attachmentId}`}
            attachmentId={attachmentPreview.attachmentId}
            filename={attachmentPreview.filename}
            read={api.attachments.read}
            translate={editorTranslate}
            onClose={() => setAttachmentPreview(null)}
            onOpenAttachment={(attachmentId, filename) =>
              setAttachmentPreview({
                issueId: issue.id,
                attachmentId,
                filename,
              })
            }
          />
        </IssueMarkdownProvider>
      ) : null}
      {selectedExecution && api.runtime ? (
        <IssueExecutionDetails
          target={
            project?.project_store === 'backend'
              ? {
                  ...selectedExecution,
                  address: {
                    ...selectedExecution.address,
                    projectSession: {
                      projectId: String(project.id),
                      issueId: issue.id,
                    },
                  },
                }
              : selectedExecution
          }
          runtime={api.runtime}
          translate={editorTranslate}
          onClose={closeExecution}
        />
      ) : null}
    </>
  )
}
