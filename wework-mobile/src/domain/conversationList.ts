import type { ConversationItem, RuntimeDeviceWorkspace } from '@/types/runtime'

export interface ConversationProjectGroup {
  key: string
  name: string
  detail: string | null
  workspace: RuntimeDeviceWorkspace | undefined
  conversations: ConversationItem[]
}

export interface ConversationListPresentation {
  pinned: ConversationItem[]
  projects: ConversationProjectGroup[]
  standalone: ConversationItem[]
}

interface ProjectWorkspace {
  projectName: string
  workspace: RuntimeDeviceWorkspace
}

export function buildConversationList(
  conversations: readonly ConversationItem[],
  workspaces: readonly ProjectWorkspace[]
): ConversationListPresentation {
  const projects = new Map<string, ConversationProjectGroup>()
  for (const { projectName, workspace } of workspaces) {
    const key = workspaceKey(workspace.deviceId, workspace.workspacePath)
    if (projects.has(key)) continue
    projects.set(key, {
      key,
      name: projectName,
      detail: workspaceDetail(projectName, workspace.workspacePath, workspace.label),
      workspace,
      conversations: [],
    })
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
    let group = projects.get(key)
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

  return { pinned, projects: [...projects.values()], standalone }
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
