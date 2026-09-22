import { useMemo } from 'react'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import type { SharedIssueDetailTaskBinding } from './createSharedIssueDetailPort'
import { IssueTaskConversationPanel } from './IssueTaskConversationPanel'
import { BrowserTaskConversationContent } from './BrowserTaskConversationContent'

export function IssueTaskConversation({
  binding,
  issueId,
  projectStore,
  runtime,
  translate,
  onClose,
}: {
  binding: SharedIssueDetailTaskBinding
  issueId: string
  projectStore?: 'local' | 'backend'
  runtime: SharedWorkspaceRuntimeApi
  translate: CollaborationTranslate
  onClose(): void
}) {
  const address = useMemo(
    () => ({
      deviceId: binding.device_id,
      taskId: binding.task_id,
      ...(projectStore === 'backend'
        ? { projectSession: { projectId: binding.cloud_project_id, issueId } }
        : {}),
    }),
    [binding.device_id, binding.task_id, binding.cloud_project_id, issueId, projectStore]
  )
  return (
    <IssueTaskConversationPanel
      issueId={issueId}
      existingTask
      translate={translate}
      onClose={onClose}
    >
      <BrowserTaskConversationContent
        runtime={runtime}
        address={address}
        projectId={binding.cloud_project_id}
        translate={translate}
      />
    </IssueTaskConversationPanel>
  )
}
