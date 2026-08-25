import type { WorkbenchMessage } from '@/types/workbench'

export const PLUGIN_WORKSPACE_RESULT_MARKER = '[WEGENT_PLUGIN_RESULT]'

export interface PluginWorkspaceResult {
  schemaVersion: 1
  taskId: string
  relativePath: string
  name: string
  displayName: string
  description: string
  version: string
  listingType: 'plugin' | 'skill'
  logo: string
  sha256: string
  status: 'ready' | 'published' | 'pending_review'
  pluginId?: number
  submissionId?: number
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return false
  return !value.split(/[\\/]+/).some(segment => !segment || segment === '.' || segment === '..')
}

function pluginWorkspaceResult(value: unknown): PluginWorkspaceResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PluginWorkspaceResult>
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.taskId !== 'string' ||
    typeof candidate.relativePath !== 'string' ||
    !isSafeRelativePath(candidate.relativePath) ||
    typeof candidate.name !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.description !== 'string' ||
    typeof candidate.version !== 'string' ||
    (candidate.listingType !== 'plugin' && candidate.listingType !== 'skill') ||
    typeof candidate.logo !== 'string' ||
    typeof candidate.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(candidate.sha256) ||
    !['ready', 'published', 'pending_review'].includes(candidate.status || '')
  ) {
    return null
  }
  return candidate as PluginWorkspaceResult
}

export function parsePluginWorkspaceResults(content: string): PluginWorkspaceResult[] {
  const results: PluginWorkspaceResult[] = []
  for (const line of content.split(/\r?\n/)) {
    const markerIndex = line.indexOf(PLUGIN_WORKSPACE_RESULT_MARKER)
    if (markerIndex < 0) continue
    const payload = line.slice(markerIndex + PLUGIN_WORKSPACE_RESULT_MARKER.length).trim()
    try {
      const result = pluginWorkspaceResult(JSON.parse(payload))
      if (result) results.push(result)
    } catch {
      // Invalid model-authored markers remain ordinary text and do not become actions.
    }
  }
  return results
}

export function stripPluginWorkspaceResultMarkers(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(line => !parsePluginWorkspaceResults(line).length)
    .join('\n')
    .trimEnd()
}

export function latestPluginWorkspaceResult(
  messages: WorkbenchMessage[],
  taskId?: string | null
): PluginWorkspaceResult | null {
  const normalizedTaskId = taskId?.trim() || ''
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant' || message.status === 'streaming') continue
    const results = parsePluginWorkspaceResults(message.content)
    for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = results[resultIndex]
      if (!normalizedTaskId || result.taskId === normalizedTaskId) return result
    }
  }
  return null
}

export function pluginWorkspaceManifestPath(
  workspacePath: string | null | undefined,
  result: PluginWorkspaceResult
): string {
  const normalizedWorkspace = workspacePath?.replace(/[\\/]+$/, '') || ''
  const relativeManifest = `${result.relativePath}/.codex-plugin/plugin.json`
  return normalizedWorkspace ? `${normalizedWorkspace}/${relativeManifest}` : relativeManifest
}
