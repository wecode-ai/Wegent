import type {
  CollaborationIssue,
  CollaborationProject,
  IssueParticipationViewer,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { canStartWorkOnCollaborationIssue } from '@wegent/collaboration'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  bindingAddress,
  matchesExperienceViewer,
  projectViewer,
  runtimeAddressKey,
  validSourceTimestamp,
} from './sourceIdentity'
import type { ExperienceConversationSelection, ExperiencePrivateConversation } from './types'

export interface ExperienceConversationInput {
  project: CollaborationProject
  issue: CollaborationIssue | null | undefined
  viewer: IssueParticipationViewer
  taskBindings?: readonly WorkspaceTaskBinding[] | null
  runtimeWork?: RuntimeWorkListResponse | null
}

export function selectPrivateConversations(
  input: ExperienceConversationInput
): ExperienceConversationSelection {
  if (!input.issue || !input.taskBindings) return { state: 'unknown', items: [] }
  if (!canStartWorkOnCollaborationIssue(input.issue)) return { state: 'hidden', items: [] }
  if (input.issue.cloud_project_id !== input.project.id) return { state: 'unknown', items: [] }
  const viewer = projectViewer(input.project, input.viewer)
  const items = new Map<string, ExperiencePrivateConversation>()
  let hidden = false
  let unknown = false
  for (const binding of input.taskBindings) {
    if (binding.projectId !== input.project.id || binding.issueId !== input.issue.id) continue
    if (!matchesExperienceViewer(binding.taskUserId, viewer)) {
      hidden = true
      continue
    }
    if (!binding.deviceId || !binding.taskId) {
      unknown = true
      continue
    }
    const address = bindingAddress(binding, input.runtimeWork)
    const key = runtimeAddressKey(address)
    const previous = items.get(key)
    if (previous) {
      if (!previous.bindingIds.includes(binding.id)) previous.bindingIds.push(binding.id)
      continue
    }
    items.set(key, {
      issueSource: {
        projectStore: input.project.project_store,
        projectId: input.project.id,
        issueId: input.issue.id,
      },
      key,
      bindingIds: [binding.id],
      ownerUserId: binding.taskUserId,
      address,
      title: binding.taskTitle ?? findRuntimeTask(input.runtimeWork, address)?.title ?? null,
      linkedAt: validSourceTimestamp(binding.linkedAt),
      sourceNodeIds: [],
    })
  }
  return { state: hidden ? 'hidden' : unknown ? 'unknown' : 'ready', items: [...items.values()] }
}
