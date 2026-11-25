import { useRef } from 'react'
import type { CollaborationIssue, CollaborationProject } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'
import type { CommentChildInput } from './useCommentAssignment'
import { issueAssigneeTarget, type IssueAssigneeTarget } from './IssueDetailDraft'
import { issueDraftFromText } from '../issueDraft'

/** Retain a persisted child when a later assignment fails. Never mutate its parent. */
export function useCommentChildIssue({
  port,
  project,
  parent,
  resolveTarget,
  assign,
  onCreated,
}: {
  port: Pick<SharedIssueDetailPort, 'issues'>
  project?: CollaborationProject
  parent: CollaborationIssue | null
  resolveTarget(target: IssueAssigneeTarget): Promise<IssueAssigneeTarget>
  assign(
    issue: CollaborationIssue,
    target: IssueAssigneeTarget,
    notify: boolean
  ): Promise<CollaborationIssue>
  onCreated(issue: CollaborationIssue): void
}) {
  const progress = useRef(new Map<string, CollaborationIssue>())
  return async (input: CommentChildInput): Promise<CollaborationIssue> => {
    if (!parent || (parent.cloud_project_id && !project) || !input.body.trim())
      throw new Error('Issue context is unavailable')
    const projectId = project?.id ?? ''
    const key = JSON.stringify([project?.project_store, projectId, parent.id, input.requestId])
    const target = await resolveTarget(
      (input.target && !input.target.includes(':')
        ? `user:${input.target}`
        : input.target) as IssueAssigneeTarget
    )
    let child = progress.current.get(key)
    if (!child) {
      const draft = issueDraftFromText(input.body)
      child = await port.issues.create(projectId, {
        request_id: input.requestId,
        title: Array.from(draft.title).slice(0, 255).join(''),
        description: project
          ? `${draft.description}\n\n[$#${parent.sequence_number} ${parent.title.replaceAll('[', '').replaceAll(']', '')}](wework-issue://${encodeURIComponent(project.id)}/${encodeURIComponent(parent.id)})`
          : draft.description,
        parent_id: parent.id,
        priority: parent.priority,
        ...(target.startsWith('user:')
          ? { assignee_user_id: Number(target.slice(5)), notify_assignee: true }
          : {}),
        ...(!project && target.startsWith('agent:') ? { assignee_agent_id: target.slice(6) } : {}),
        ...(!project && target.startsWith('group:') ? { assignee_group_id: target.slice(6) } : {}),
      })
      progress.current.set(key, child)
    } else child = await port.issues.get(child.id)
    if (target && issueAssigneeTarget(child) !== target) {
      child = await assign(child, target, true)
      progress.current.set(key, child)
    }
    onCreated(child)
    return child
  }
}
