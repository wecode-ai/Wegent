import type { CloudProject } from '@/api/deliveries'

export { repositoryProviderConfig } from '@wegent/collaboration/project-create'

export interface DingTalkAITableLink {
  baseId: string
  tableId: string
  viewId?: string
  url: string
}

export function parseDingTalkAITableLink(value: string): DingTalkAITableLink | null {
  try {
    const url = new URL(value.trim())
    if (url.hostname !== 'alidocs.dingtalk.com') return null
    const nodeMatch = url.pathname.match(/\/i\/nodes\/([^/]+)/)
    if (!nodeMatch?.[1]) return null
    const embedded = new URLSearchParams(url.searchParams.get('iframeQuery') ?? '')
    const tableId = embedded.get('sheetId') ?? url.searchParams.get('sheetId')
    if (!tableId?.trim()) return null
    const viewId = embedded.get('viewId') ?? url.searchParams.get('viewId')
    return {
      baseId: decodeURIComponent(nodeMatch[1]),
      tableId: tableId.trim(),
      ...(viewId?.trim() ? { viewId: viewId.trim() } : {}),
      url: url.toString(),
    }
  } catch {
    return null
  }
}

export {
  dingtalkAITableRuntimeContext,
  projectSpaceChatRuntimeContext,
} from '@wegent/chat-core/project-space-context'

export function repositoryAddress(project: CloudProject): string {
  const repository = project.provider_config.repository ?? ''
  const defaultDomain = project.task_provider === 'github' ? 'github.com' : 'gitlab.com'
  const domain = project.provider_config.domain ?? defaultDomain
  return repository ? `https://${domain}/${repository}` : ''
}
