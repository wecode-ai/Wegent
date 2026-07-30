import type { CloudProject } from '@/api/deliveries'
import type { RuntimeAdditionalContext } from '@/types/api'

export type ExternalProjectTaskProvider = 'github' | 'gitlab'

export function repositoryProviderConfig(
  address: string,
  provider: ExternalProjectTaskProvider
): {
  repository: string
  domain?: string
  api_base?: string
} {
  const value = address.trim()
  if (!value) throw new Error('请输入仓库地址')

  const shorthand = value.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (shorthand) {
    return { repository: `${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}` }
  }

  const ssh = value.match(/^git@([^:]+):(.+)$/)
  let domain: string
  let pathname: string
  if (ssh) {
    domain = ssh[1].toLowerCase()
    pathname = ssh[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('请输入完整仓库地址，或使用 owner/repository 格式')
    }
    domain = parsed.hostname.toLowerCase()
    pathname = parsed.pathname
  }

  const repositoryPath = pathname.replace(/^\/+|\/+$/g, '')
  const repositoryWithoutPage =
    provider === 'gitlab' ? (repositoryPath.split('/-/')[0] ?? repositoryPath) : repositoryPath
  const repository = repositoryWithoutPage.replace(/\.git$/, '')
  const segments = repository.split('/').filter(Boolean)
  if (segments.length < 2 || (provider === 'github' && segments.length !== 2)) {
    throw new Error(
      provider === 'github'
        ? 'GitHub 仓库地址应包含 owner/repository'
        : 'GitLab 仓库地址应包含 group/project'
    )
  }

  const defaultDomain = provider === 'github' ? 'github.com' : 'gitlab.com'
  if (domain === defaultDomain) return { repository }
  return {
    repository,
    domain,
    api_base: provider === 'github' ? `https://${domain}/api/v3` : `https://${domain}/api/v4`,
  }
}

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

export function dingtalkAITableRuntimeContext(
  project: CloudProject
): RuntimeAdditionalContext | undefined {
  if (project.task_provider !== 'dingtalk_aitable') return undefined
  const baseId = project.provider_config.base_id?.trim()
  const tableId = project.provider_config.table_id?.trim()
  if (!baseId || !tableId) return undefined
  const viewId = project.provider_config.view_id?.trim()
  const binding = {
    default_target: {
      space_id: String(project.id),
      space_name: project.name,
      project_key: project.project_key,
      provider: 'dingtalk_aitable',
      dws_product: 'aitable',
      base_id: baseId,
      table_id: tableId,
      ...(viewId ? { view_id: viewId } : {}),
      ...(project.provider_config.board_mapping
        ? { board_mapping: project.provider_config.board_mapping }
        : {}),
    },
    semantics: {
      board_item: 'aitable_record',
      source_of_truth: 'dingtalk',
    },
    resolution_policy: {
      implicit_reference: 'use_default_target',
      named_space_reference: 'list_spaces_then_use_that_space_binding',
      explicit_dingtalk_search: 'allow_dws_search',
      ambiguous_reference: 'ask_or_list_candidates',
      bound_target_failure: 'report_error_without_switching_resources',
    },
  }
  const rules = [
    'The project resource binding above is authoritative.',
    'For an implicit reference such as "this project" or "my tasks", use the default target IDs directly with the dws skill and its aitable commands. Do not search or list DingTalk bases first.',
    "If the user explicitly names another Wework project, use wework_space list_spaces to resolve it, then use that project's provider binding.",
    'Only search DingTalk bases when the user explicitly asks to find an arbitrary DingTalk resource outside the bound Wework project.',
    'Inspect the live table schema before referring to fields. Never guess identifiers or field names.',
    'Do not use wework_space board-item or table CRUD tools for DingTalk AI Table data.',
    'If the bound resource cannot be accessed, report that error and do not silently switch to another table.',
    'Follow dws confirmation requirements for destructive operations.',
  ]
  return {
    dingtalkAITableProject: {
      kind: 'application',
      value: [
        '<project_resource_binding version="1">',
        JSON.stringify(binding, null, 2),
        '</project_resource_binding>',
        '',
        ...rules,
      ].join('\n'),
    },
  }
}

export function repositoryAddress(project: CloudProject): string {
  const repository = project.provider_config.repository ?? ''
  const defaultDomain = project.task_provider === 'github' ? 'github.com' : 'gitlab.com'
  const domain = project.provider_config.domain ?? defaultDomain
  return repository ? `https://${domain}/${repository}` : ''
}
