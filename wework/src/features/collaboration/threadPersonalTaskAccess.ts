import type { CollaborationAssignment, CollaborationIssue } from '@wegent/collaboration'
import { isPersonalTaskAssignee } from '@/features/todo/issuePersonalTaskEligibility'
import type { ThreadActionContext } from './threadActions'

const closedStates = new Set(['completed', 'cancelled', 'archived'])

export function threadWorkOwner(
  account: string,
  store: string,
  groupId: string | null,
  threadId: string | null
): string {
  return JSON.stringify([account, store, groupId, threadId])
}

export function threadActionOwner(context: ThreadActionContext): string {
  return threadWorkOwner(
    context.accountScope,
    context.sourceStore,
    context.group.id,
    context.item.id
  )
}

export function hasThreadWorkOwner(context: ThreadActionContext): boolean {
  return (
    context.project.resource_type === 'chat_group' &&
    String(context.project.id) === context.group.id &&
    context.item.group_id === context.group.id &&
    String(context.item.cloud_project_id) === context.group.id &&
    context.project.project_store === (context.sourceStore === 'local' ? 'local' : 'backend')
  )
}

export function canStartThreadPersonalTask(context: ThreadActionContext): boolean {
  return (
    hasThreadWorkOwner(context) &&
    context.group.status === 'active' &&
    ['Owner', 'Maintainer', 'Developer'].includes(context.group.role) &&
    context.participation?.joined === true &&
    context.participation.can_comment &&
    !closedStates.has(context.item.status)
  )
}

export function currentPersonalAssignment(items: CollaborationAssignment[]) {
  return items
    .filter(item => item.status === 'active')
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .at(-1)
}

export async function requireThreadPersonalTaskStart(
  context: ThreadActionContext,
  unavailable: string
): Promise<CollaborationIssue> {
  if (!canStartThreadPersonalTask(context)) throw new Error(unavailable)
  const actor = context.participation!.current_user_id
  const [item, assignments] = await Promise.all([
    context.api.issues.get(context.item.id),
    context.api.assignments?.list(context.item.id) ?? Promise.resolve([]),
  ])
  const facts = item as CollaborationIssue & {
    group_status?: string
    permissions?: { execute?: boolean }
  }
  if (
    item.id !== context.item.id ||
    item.group_id !== context.group.id ||
    String(item.cloud_project_id) !== context.group.id ||
    item.joined !== true ||
    (facts.group_status !== undefined && facts.group_status !== 'active') ||
    facts.permissions?.execute === false ||
    closedStates.has(item.status) ||
    !isPersonalTaskAssignee(item, actor, currentPersonalAssignment(assignments))
  )
    throw new Error(unavailable)
  return item
}
