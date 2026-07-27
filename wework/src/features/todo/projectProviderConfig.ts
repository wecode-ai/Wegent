import type { CloudProject } from '@/api/deliveries'

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

  const repository = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
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

export function repositoryAddress(project: CloudProject): string {
  const repository = project.provider_config.repository ?? ''
  const defaultDomain = project.task_provider === 'github' ? 'github.com' : 'gitlab.com'
  const domain = project.provider_config.domain ?? defaultDomain
  return repository ? `https://${domain}/${repository}` : ''
}
