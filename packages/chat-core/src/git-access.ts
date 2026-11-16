export const GIT_ACCESS_ERROR_PREFIX = 'git-access:'

export type GitAccessCode =
  | 'credentials-required'
  | 'authentication-failed'
  | 'ssh-authentication-failed'
  | 'repository-inaccessible'
  | 'network-error'
  | 'git-unavailable'
  | 'invalid-url'
  | 'clone-failed'

export interface GitAccessFailure {
  code: GitAccessCode
  domain: string
  message: string
}

const codes: GitAccessCode[] = [
  'credentials-required',
  'authentication-failed',
  'ssh-authentication-failed',
  'repository-inaccessible',
  'network-error',
  'git-unavailable',
  'invalid-url',
  'clone-failed',
]

export function parseGitAccessFailure(error: unknown): GitAccessFailure | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const start = message.indexOf(GIT_ACCESS_ERROR_PREFIX)
  if (start < 0) return
  try {
    const value = JSON.parse(message.slice(start + GIT_ACCESS_ERROR_PREFIX.length))
    if (
      codes.includes(value.code) &&
      typeof value.domain === 'string' &&
      typeof value.message === 'string'
    ) {
      return { code: value.code, domain: value.domain, message: value.message }
    }
  } catch {
    // Older or malformed device diagnostics remain ordinary operation errors.
  }
}

export function needsGitConfiguration(failure?: GitAccessFailure): boolean {
  return failure?.code === 'credentials-required' || failure?.code === 'authentication-failed'
}

export function gitRepositoryDomain(value: string): string {
  try {
    if (value.includes('://')) {
      const parsed = new URL(value)
      const authority = value.split('://')[1].split(/[/?#]/)[0]
      const explicitPort = authority.match(/:(\d+)$/)?.[1]
      const port = parsed.port || (explicitPort ? String(Number(explicitPort)) : '')
      return `${parsed.hostname}${port ? `:${port}` : ''}`.toLowerCase()
    }
    return value.match(/^(?:[^/@]+@)?([^/:\\]{2,}):[^/]/)?.[1]?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

export function gitAccountSettingsUrl(
  connection: { webUrl?: string; backendUrl?: string },
  domain?: string
): string | null {
  const base = connection.webUrl
  if (!base) return null
  try {
    const parsed = new URL(base)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    const url = new URL(parsed.pathname, parsed.origin)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/settings`
    url.search = ''
    url.searchParams.set('tab', 'integrations')
    if (domain) url.searchParams.set('gitDomain', domain)
    url.hash = 'git-accounts'
    return url.toString()
  } catch {
    return null
  }
}
