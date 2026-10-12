import type { LocalConnectorAuthTarget } from './localConnectorAuth'

export const GITHUB_CLI_TARGET: LocalConnectorAuthTarget = {
  pluginKey: 'github',
  connectorSlug: 'wework-github-cli',
  localAuth: { kind: 'browser_oauth', health: [], start: [], poll: [], pollIntervalSeconds: 1 },
}

export function isGithubCliTarget(target: LocalConnectorAuthTarget): boolean {
  return (
    target.pluginKey === GITHUB_CLI_TARGET.pluginKey &&
    target.connectorSlug === GITHUB_CLI_TARGET.connectorSlug
  )
}

export function githubVerificationUrl(address?: string | null): string | null {
  if (!address) return null
  try {
    const url = new URL(address)
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      ['/login/device', '/login/oauth/authorize'].includes(url.pathname)
      ? url.href
      : null
  } catch {
    return null
  }
}
