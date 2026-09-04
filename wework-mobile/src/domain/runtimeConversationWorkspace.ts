const DEFAULT_CONVERSATION_WORKSPACE_NAME = 'new-chat'
const MAX_CONVERSATION_WORKSPACE_NAME_LENGTH = 20
const PARENT_TRAVERSAL_ERROR = 'Workspace path cannot contain parent traversal'

interface ConversationWorkspaceDeviceApi {
  createDirectory(deviceId: string, path: string): Promise<void>
  getHomeDirectory(deviceId: string): Promise<string>
}

export async function createConversationWorkspace(
  deviceApi: ConversationWorkspaceDeviceApi,
  deviceId: string,
  message: string,
  taskId: string
): Promise<string> {
  const homeDirectory = await deviceApi.getHomeDirectory(deviceId)
  const workspacePath = buildConversationWorkspacePath(homeDirectory, message, taskId)
  await deviceApi.createDirectory(deviceId, workspacePath)
  return workspacePath
}

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

function joinDevicePath(root: string, ...segments: string[]): string {
  const normalizedRoot = normalizeDevicePath(root)
  const absolute = normalizedRoot.startsWith('/') || root.trim().startsWith('/')
  const parts = [
    absolute ? normalizedRoot.replace(/^\/+|\/+$/g, '') : normalizedRoot,
    ...segments.map(segment => normalizeRelativePath(segment)),
  ].filter(Boolean)
  const joined = parts.join('/')
  return absolute ? (joined ? `/${joined}` : '/') : joined
}

function normalizeRelativePath(path: string): string {
  return normalizeDevicePath(path.replace(/^\/+/, '')).replace(/^\/+/, '')
}

function normalizeDevicePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed) return ''
  const absolute = trimmed.startsWith('/')
  const segments: string[] = []
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(PARENT_TRAVERSAL_ERROR)
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const normalized = segments.join('/')
  return absolute ? (normalized ? `/${normalized}` : '/') : normalized
}
