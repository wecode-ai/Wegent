import { useMemo } from 'react'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import type { SharedIssueDetailTaskBinding } from './createSharedIssueDetailPort'
import { IssueTaskConversationPanel } from './IssueTaskConversationPanel'
import { BrowserTaskConversationContent } from './BrowserTaskConversationContent'

export function IssueTaskConversation({
  binding,
  issueId,
  runtime,
  translate,
  onClose,
}: {
  binding: SharedIssueDetailTaskBinding
  issueId: string
  runtime: SharedWorkspaceRuntimeApi
  translate: CollaborationTranslate
  onClose(): void
}) {
  const address = useMemo(
    () => ({ deviceId: binding.device_id, taskId: binding.task_id }),
    [binding.device_id, binding.task_id]
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
