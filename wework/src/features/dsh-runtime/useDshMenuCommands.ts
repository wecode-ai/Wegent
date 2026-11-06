import { useSyncExternalStore } from 'react'

import {
  getDshExtensionHost,
  subscribeDshExtensions,
  type WeworkCommandDefinition,
  type WeworkMenuTitle,
  type WeworkResolvedMenuContribution,
} from './dshExtensions'

export interface DshMenuCommand extends WeworkResolvedMenuContribution {
  readonly definition: WeworkCommandDefinition
  readonly icon?: string
  readonly title: string
}

function resolveMenuTitle(title: WeworkMenuTitle | undefined): string | null {
  if (typeof title === 'function') {
    try {
      const value = title()
      return typeof value === 'string' && value.trim() ? value : null
    } catch (error) {
      console.error('[Wework] Failed to resolve DSH menu title:', error)
      return null
    }
  }
  return typeof title === 'string' && title.trim() ? title : null
}

export function resolveDshMenuCommands(location: string): readonly DshMenuCommand[] {
  const host = getDshExtensionHost()
  if (!host) return []
  return host.menus.list(location).flatMap(item => {
    const definition = host.commands.get(item.command)
    if (!definition) return []
    return [
      {
        ...item,
        definition,
        enabled: item.enabled && host.context.matches(definition.enablement),
        icon: item.icon ?? definition.icon,
        title: resolveMenuTitle(item.title) ?? definition.title,
      },
    ]
  })
}

export function useDshMenuCommands(location: string): readonly DshMenuCommand[] {
  useSyncExternalStore(
    subscribeDshExtensions,
    () => getDshExtensionHost()?.getRevision() ?? 0,
    () => 0
  )

  return resolveDshMenuCommands(location)
}
