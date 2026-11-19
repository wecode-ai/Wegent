import { useState } from 'react'
import { useSharedIssueDetailModel } from './issue-detail/useSharedIssueDetailModel'
import { IssueDetailDeliveryView } from './issue-detail/IssueDetailDeliveryView'
import { IssueDetailMainView } from './issue-detail/IssueDetailMainView'
import type { TodoEditorProps } from './issue-detail/issueEditorSupport'
import './issue-detail/issue-detail.css'
export type {
  SharedEditorIssue,
  SharedEditorProject,
  SharedEditorTeam,
  SharedIssueDetailExtensionContext,
  SharedIssueDetailExtensions,
  TodoEditorCreateProps,
  TodoEditorEditProps,
  TodoEditorProps,
} from './issue-detail/issueEditorSupport'
export function TodoEditor(props: TodoEditorProps) {
  const project = props.project
  const item = props.mode === 'edit' ? props.item : null
  const scope = JSON.stringify([
    props.mode,
    project?.project_store,
    project?.id ?? item?.cloud_project_id,
    item?.id,
    props.currentUserId ?? project?.current_user_id,
    project?.access_role,
    props.mode === 'edit' ? props.editable : true,
    item?.can_view_detail,
    item?.invited_only,
    props.canAssign,
    props.mode === 'create' ? (props.draftScope ?? props.initialStatus) : null,
  ])
  const [owner, setOwner] = useState({ port: props.port, scope, version: 0 })
  if (owner.port !== props.port || owner.scope !== scope)
    setOwner({ port: props.port, scope, version: owner.version + 1 })
  return <ScopedTodoEditor key={`${scope}:${owner.version}`} {...props} />
}
function ScopedTodoEditor(props: TodoEditorProps) {
  const model = useSharedIssueDetailModel(props)
  return model.selectedDelivery && model.item ? (
    <IssueDetailDeliveryView model={model} />
  ) : (
    <IssueDetailMainView model={model} />
  )
}
export const SharedIssueDetailEditor = TodoEditor
export type SharedIssueDetailEditorProps = TodoEditorProps
