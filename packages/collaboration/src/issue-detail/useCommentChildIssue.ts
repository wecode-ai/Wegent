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
    if (!project || !parent || !input.body.trim()) throw new Error('Issue context is unavailable')
    const key = `${project.project_store}:${project.id}:${parent.id}:${input.requestId}`
    const target = await resolveTarget(
      (input.target && !input.target.includes(':')
        ? `user:${input.target}`
        : input.target) as IssueAssigneeTarget
    )
    let child = progress.current.get(key)
    if (!child) {
      const draft = issueDraftFromText(input.body)
      child = await port.issues.create(project.id, {
        title: Array.from(draft.title).slice(0, 255).join(''),
        description: `${draft.description}\n\n[$#${parent.sequence_number} ${parent.title.replace(/[\[\]]/g, '')}](wework-issue://${encodeURIComponent(project.id)}/${encodeURIComponent(parent.id)})`,
        parent_id: parent.id,
        priority: parent.priority,
        ...(target.startsWith('user:')
          ? { assignee_user_id: Number(target.slice(5)), notify_assignee: true }
          : {}),
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
