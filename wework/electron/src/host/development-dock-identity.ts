export interface DevelopmentDockIdentity {
  badge: string
  displayName: string
  instanceId: string
}

interface DevelopmentEnvironment {
  WEWORK_DEV_DOCK_TITLE?: string
  WEWORK_DEV_INSTANCE_ID?: string
  WEWORK_DEV_INSTANCE_LABEL?: string
  WEWORK_DEV_TITLE?: string
  WEWORK_DEV_WORKTREE?: string
}

function findRuntimeInstanceId(worktree: string | undefined): string | null {
  const segments = worktree?.split(/[\\/]+/).filter(Boolean) ?? []
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = /^runtime-(.+)$/.exec(segments[index])
    if (match?.[1]) return match[1]
  }
  return null
}

function shortenDockBadge(instanceId: string): string {
  return Array.from(instanceId).slice(0, 4).join('')
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  return null
}

export function resolveDevelopmentDockIdentity(
  environment: DevelopmentEnvironment
): DevelopmentDockIdentity | null {
  const title = environment.WEWORK_DEV_TITLE?.trim()
  if (!title) return null

  const instanceId = firstNonEmpty(
    environment.WEWORK_DEV_INSTANCE_LABEL,
    findRuntimeInstanceId(environment.WEWORK_DEV_WORKTREE) ?? environment.WEWORK_DEV_INSTANCE_ID
  )
  if (!instanceId) return null
  const badge = shortenDockBadge(instanceId)
  const configuredDisplayName = environment.WEWORK_DEV_DOCK_TITLE?.trim()

  return {
    badge,
    displayName: configuredDisplayName || `${title} · ${badge}`,
    instanceId,
  }
}
