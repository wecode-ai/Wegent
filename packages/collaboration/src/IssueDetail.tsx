import { BrowserTaskDrafts } from './issue-detail/BrowserTaskDrafts'
import { RuntimeConversationScope } from './conversation/RuntimeConversationScope'
import { IssueTaskConversation } from './issue-detail/IssueTaskConversation'
import type { SharedIssueDetailTaskBinding } from './issue-detail/createSharedIssueDetailPort'
import type { RuntimeExecutionTarget } from './issue-detail/runtimeExecutionTarget'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { collaborationTestIds } from './testIds'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

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
import { dueDateTimeLocalFromSource, dueDateTimeLocalToSource } from './issue-detail/dateTime'
import { getCollaborationIssueActionPermissions } from './permissions'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import { IssueExecutionDetails } from './issue-detail/IssueExecutionDetails'
import { IssueConversationDrawers } from './issue-detail/IssueConversationDrawers'
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
} from './types'

type Messages = (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en']

interface IssueDetailProps {
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
    | 'collaborators'
    | 'taskBindings'
    | 'workflowPlans'
    | 'deliveries'
    | 'automations'
  >
  project: CollaborationProject
  issue: CollaborationIssue
  allIssues: CollaborationIssue[]
  comments: CollaborationComment[]
  assignments?: CollaborationAssignment[]
  executions?: CollaborationExecution[]
  members?: CollaborationMember[]
  agents?: CollaborationAgent[]
  messages: Messages
  translate?: CollaborationTranslate
  onClose(): void
  /** Present only when the host enabled Issue deletion. */
  onDelete?(): void
  onChange(issue: CollaborationIssue): void
  onCommentsChange(comments: CollaborationComment[]): void
  onAssignmentsChange?(assignments: CollaborationAssignment[]): void
  onCreateTask?(workflowStep?: string): void
  onConflict(): Promise<void>
  onError(): void
}

interface IssueCreateProps {
  api: IssueDetailProps['api']
  project: CollaborationProject
  allIssues: CollaborationIssue[]
  messages: Messages
  translate?: CollaborationTranslate
  onClose(): void
  onCreated(issue: CollaborationIssue): void | Promise<void>
  onError(): void
}

const browserDueDateExtensions = {
  dueDateInputType: 'datetime-local' as const,
  dueDateFromSource: dueDateTimeLocalFromSource,
  dueDateToSource: dueDateTimeLocalToSource,
}

function browserSave(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
  return Promise.resolve()
}

function useBrowserIssueDetailPort(
  api: IssueDetailProps['api'],
  onError: () => void,
  onConflict?: () => Promise<void>
) {
  const callbacks = useRef({ onError, onConflict })
  useLayoutEffect(() => {
    callbacks.current = { onError, onConflict }
  }, [onError, onConflict])

  return useMemo(() => {
    const basePort = createSharedIssueDetailPort(api, browserSave)
    return {
      ...basePort,
      issues: {
        ...basePort.issues,
        create: async (...args: Parameters<typeof basePort.issues.create>) => {
          try {
            return await basePort.issues.create(...args)
          } catch (error) {
            callbacks.current.onError()
            throw error
          }
        },
        update: async (...args: Parameters<typeof basePort.issues.update>) => {
          try {
            return await basePort.issues.update(...args)
          } catch (error) {
            if (
              callbacks.current.onConflict &&
              error &&
              typeof error === 'object' &&
              'status' in error &&
              error.status === 409
            ) {
              await callbacks.current.onConflict()
            } else {
              callbacks.current.onError()
            }
            throw error
          }
        },
        assign: async (...args: Parameters<typeof basePort.issues.assign>) => {
          try {
            return await basePort.issues.assign(...args)
          } catch (error) {
            callbacks.current.onError()
            throw error
          }
        },
      },
    }
  }, [api])
}

export function IssueCreate({
  api,
  project,
  allIssues,
  messages,
  translate,
  onClose,
  onCreated,
  onError,
}: IssueCreateProps) {
  const port = useBrowserIssueDetailPort(api, onError)
  const editorTranslate =
    translate ??
    createCollaborationTranslator(messages === collaborationMessages.en ? 'en' : 'zh-CN')
  return (
    <div data-testid={collaborationTestIds.createIssueDialog}>
      <SharedIssueDetailEditor
        port={port}
        mode="create"
        project={project as SharedEditorProject}
        allItems={allIssues as SharedEditorIssue[]}
        initialParent={null}
        initialStatus={project.board_config?.statuses?.[0]?.id ?? 'inbox'}
        onClose={onClose}
        onCreated={onCreated}
        translate={editorTranslate}
        extensions={browserDueDateExtensions}
      />
    </div>
  )
}

export function IssueDetail(props: IssueDetailProps) {
  return props.api.runtime ? (
    <BrowserTaskDrafts runtime={props.api.runtime}>
      <RuntimeConversationScope key={props.issue.id} runtime={props.api.runtime}>
        <BrowserIssueDetail {...props} />
      </RuntimeConversationScope>
    </BrowserTaskDrafts>
  ) : (
    <BrowserIssueDetail {...props} />
  )
}

function BrowserIssueDetail({
  api,
  project,
  issue,
  allIssues,
  comments,
  assignments = [],
  executions = [],
  members = [],
  agents = [],
  messages,
  translate,
  onClose,
  onDelete,
  onChange,
  onCommentsChange,
  onCreateTask,
  onConflict,
  onError,
}: IssueDetailProps) {
  const [conversationSelection, setConversationSelection] = useState<{
    issueId: string
    binding: SharedIssueDetailTaskBinding
  } | null>(null)
  const selectedConversation =
    conversationSelection?.issueId === issue.id ? conversationSelection.binding : null
  const closeConversation = () => setConversationSelection(null)
  const [selection, setSelection] = useState<{
    issueId: string
    target: RuntimeExecutionTarget
  } | null>(null)
  const selectedExecution = selection?.issueId === issue.id ? selection.target : null
  const closeExecution = () => setSelection(null)
  const permissions = getCollaborationIssueActionPermissions(project, issue)
  const port = useBrowserIssueDetailPort(api, onError, onConflict)
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
        label={editorTranslate('todo.issue_details', '任务详情')}
        conversation={
          selectedConversation && api.runtime ? (
            <IssueTaskConversation
              projectStore={project.project_store}
              key={selectedConversation.id}
              binding={selectedConversation}
              issueId={issue.id}
              runtime={api.runtime}
              translate={editorTranslate}
              onClose={closeConversation}
            />
          ) : null
        }
        conversationKey={selectedConversation?.id}
        onCloseConversation={closeConversation}
        onClose={selectedExecution ? closeExecution : onClose}
      >
        {closeDrawers => (
          <SharedIssueDetailEditor
            port={port}
            mode="edit"
            item={issue as SharedEditorIssue}
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
            onUpdated={updated => onChange(updated)}
            presentation="workspace-panel"
            workspacePanelFill
            readFirst
            showPanelControls
            showFullscreenControl={false}
            showAssignee
            canAssign={permissions.canAssign}
            currentAssignment={currentAssignment}
            canStartWork={permissions.canStartWork}
            onCreateTask={onCreateTask}
            translate={editorTranslate}
            extensions={{
              ...browserDueDateExtensions,
              openAttachment: async attachmentId => {
                const access = await api.attachments.access(attachmentId)
                window.open(access.url, '_blank', 'noopener,noreferrer')
              },
              renderActivity: ({ tasks }) => (
                <IssueActivityPanel
                  api={api}
                  issue={issue}
                  project={project}
                  onTaskUpdated={onChange}
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
                    void api.attachments
                      .read(id)
                      .then(blob => browserSave(blob, filename))
                      .catch(onError)
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
      {selectedExecution && api.runtime ? (
        <IssueExecutionDetails
          target={
            project.project_store === 'backend'
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
