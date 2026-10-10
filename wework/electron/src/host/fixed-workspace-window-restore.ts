export interface FixedWorkspaceWindowDescriptor {
  label: string
  route: string
  title: string
}

function defaultContentRoute(kind: string): string | null {
  if (kind === 'task') return '/'
  if (kind === 'board') return '/todo'
  if (kind === 'agent') return '/app/wegent'
  return null
}

function workspaceTabRoute(contentRoute: string, id: string, title: string): string {
  const target = new URL(contentRoute, 'https://wework.invalid')
  target.searchParams.set('workspaceTab', id)
  target.searchParams.set('workspaceTabTitle', title)
  return `${target.pathname}${target.search}${target.hash}`
}

export function fixedWorkspaceWindowDescriptors(
  preferences: Record<string, unknown>
): FixedWorkspaceWindowDescriptor[] {
  if (!Array.isArray(preferences.fixedWorkspaceTabs)) return []
  return preferences.fixedWorkspaceTabs.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const kind = typeof record.kind === 'string' ? record.kind : ''
    const label = typeof record.windowLabel === 'string' ? record.windowLabel.trim() : ''
    const title =
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : kind
    const installationId =
      typeof record.installationId === 'string' ? record.installationId.trim() : ''
    const configuredRoute =
      typeof record.contentRoute === 'string' ? record.contentRoute.trim() : ''
    const contentRoute =
      kind === 'smart_app' && installationId
        ? `/app/${encodeURIComponent(`harness-${installationId}`)}`
        : configuredRoute || defaultContentRoute(kind)
    if (!id || !contentRoute || !/^workspace-[a-zA-Z0-9_-]+$/.test(label)) {
      return []
    }
    try {
      return [
        {
          label,
          route: workspaceTabRoute(contentRoute, id, title),
          title,
        },
      ]
    } catch {
      return []
    }
  })
}
