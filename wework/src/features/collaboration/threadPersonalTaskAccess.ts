import type { CollaborationIssue } from '@wegent/collaboration'
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
    context.item.permissions?.execute === true &&
    !closedStates.has(context.item.status)
  )
}

export async function requireThreadPersonalTaskStart(
  context: ThreadActionContext,
  unavailable: string
): Promise<CollaborationIssue> {
  if (!canStartThreadPersonalTask(context)) throw new Error(unavailable)
  const item = await context.api.issues.get(context.item.id)
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
    facts.permissions?.execute !== true ||
    closedStates.has(item.status)
  )
    throw new Error(unavailable)
  return item
}
