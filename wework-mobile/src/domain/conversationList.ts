import type { ConversationItem, RuntimeDeviceWorkspace, RuntimeProjectWork } from '@/types/runtime'

export interface ConversationProjectGroup {
  key: string
  name: string
  detail: string | null
  projectWork?: RuntimeProjectWork
  workspace: RuntimeDeviceWorkspace | undefined
  conversations: ConversationItem[]
}

export interface ConversationListPresentation {
  pinned: ConversationItem[]
  pinnedProjects: ConversationProjectGroup[]
  projects: ConversationProjectGroup[]
  standalone: ConversationItem[]
}

interface ProjectWorkspace {
  projectName: string
  projectWork?: RuntimeProjectWork
  workspace: RuntimeDeviceWorkspace
}

export function buildConversationList(
  conversations: readonly ConversationItem[],
  workspaces: readonly ProjectWorkspace[]
): ConversationListPresentation {
  const projects = new Map<string, ConversationProjectGroup>()
  const locations = new Map<string, ConversationProjectGroup>()
  for (const { projectName, projectWork, workspace } of workspaces) {
    const location = workspaceKey(workspace.deviceId, workspace.workspacePath)
    const key = projectWork
      ? JSON.stringify([
          projectWork.project.stateDeviceId || workspace.deviceId,
          projectWork.project.sidebarStateKey || projectWork.project.key,
        ])
      : location
    const existing = projects.get(key)
    if (existing) {
      locations.set(location, existing)
      continue
    }
    const group: ConversationProjectGroup = {
      key,
      name: projectName,
      detail: workspaceDetail(projectName, workspace.workspacePath, workspace.label),
      workspace,
      projectWork,
      conversations: [],
    }
    projects.set(key, group)
    locations.set(location, group)
  }

  const pinned = conversations.filter(item => item.pinned).sort(comparePinnedConversations)
  const standalone: ConversationItem[] = []
  for (const conversation of conversations) {
    if (conversation.pinned) continue
    if (conversation.projectName === null) {
      standalone.push(conversation)
      continue
    }
    const key = workspaceKey(conversation.address.deviceId, conversation.sourceWorkspacePath)
    let group =
      conversation.projectKey && conversation.projectStateDeviceId
        ? projects.get(JSON.stringify([conversation.projectStateDeviceId, conversation.projectKey]))
        : locations.get(key)
    if (!group) {
      group = {
        key,
        name: conversation.projectName,
        detail: workspaceDetail(conversation.projectName, conversation.sourceWorkspacePath),
        workspace: undefined,
        conversations: [],
      }
      projects.set(key, group)
    }
    group.conversations.push(conversation)
  }

  const orderedProjects = [...projects.values()].sort(
    (a, b) =>
      (a.projectWork?.project.pinnedOrder ??
        a.projectWork?.project.sidebarOrder ??
        Number.MAX_SAFE_INTEGER) -
      (b.projectWork?.project.pinnedOrder ??
        b.projectWork?.project.sidebarOrder ??
        Number.MAX_SAFE_INTEGER)
  )
  return {
    pinned,
    pinnedProjects: orderedProjects.filter(group => group.projectWork?.project.pinned),
    projects: orderedProjects.filter(group => !group.projectWork?.project.pinned),
    standalone,
  }
}

function workspaceKey(deviceId: string, workspacePath: string): string {
  return JSON.stringify([deviceId, workspacePath])
}

function workspaceDetail(name: string, path: string, label?: string | null): string | null {
  if (label && label !== name) return label
  const basename = path.split(/[/\\]/u).filter(Boolean).at(-1)
  return basename && basename !== name ? basename : null
}

function comparePinnedConversations(left: ConversationItem, right: ConversationItem): number {
  return (
    (left.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.pinnedOrder ?? Number.MAX_SAFE_INTEGER) || right.updatedAt - left.updatedAt
  )
}
