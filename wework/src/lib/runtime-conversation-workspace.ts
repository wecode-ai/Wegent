import { joinDevicePath } from './device-workspace-path'

const DEFAULT_CONVERSATION_WORKSPACE_NAME = 'new-chat'
const MAX_CONVERSATION_WORKSPACE_NAME_LENGTH = 20

export function buildConversationWorkspacePath(
  homeDirectory: string,
  message: string,
  taskId: string,
  date = new Date()
): string {
  return joinDevicePath(
    homeDirectory,
    'Documents',
    'Codex',
    formatConversationWorkspaceDate(date),
    conversationWorkspaceName(message, taskId)
  )
}

function formatConversationWorkspaceDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function conversationWorkspaceName(message: string, taskId: string): string {
  const suffix = taskId
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(-8)
    .toLowerCase()
  const name = slugifyConversationWorkspaceName(message)
  return suffix ? `${name}-${suffix}` : name
}

function slugifyConversationWorkspaceName(message: string): string {
  const words = message.match(/[A-Za-z0-9]+/g) ?? []
  const name = words.length > 0 ? words.map(word => word.toLowerCase()).join('-') : ''
  return trimConversationWorkspaceName(name || DEFAULT_CONVERSATION_WORKSPACE_NAME)
}

function trimConversationWorkspaceName(name: string): string {
  const trimmed = name.slice(0, MAX_CONVERSATION_WORKSPACE_NAME_LENGTH).replace(/-+$/g, '')
  return trimmed || DEFAULT_CONVERSATION_WORKSPACE_NAME
}
