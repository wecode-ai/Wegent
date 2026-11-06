import type { LocalConnectorAuthTarget } from './localConnectorAuth'

export function isGitlabCliTarget(target: LocalConnectorAuthTarget): boolean {
  if (
    !(
      target.pluginKey === 'gitlab' &&
      /^wework-gitlab-cli-[a-f0-9]{64}$/.test(target.connectorSlug) &&
      Boolean(target.instance)
    )
  )
    return false
  try {
    const url = new URL(target.instance!)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function gitlabVerificationUrl(
  target: LocalConnectorAuthTarget,
  address?: string | null
): string | null {
  if (!isGitlabCliTarget(target) || !address) return null
  try {
    const url = new URL(address)
    return url.protocol === 'https:' &&
      url.origin === new URL(target.instance!).origin &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
