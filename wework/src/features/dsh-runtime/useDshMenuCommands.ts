import { useSyncExternalStore } from 'react'

import {
  getDshExtensionHost,
  subscribeDshExtensions,
  type WeworkCommandDefinition,
  type WeworkResolvedMenuContribution,
} from './dshExtensions'

export interface DshMenuCommand extends WeworkResolvedMenuContribution {
  readonly definition: WeworkCommandDefinition
  readonly icon?: string
  readonly title: string
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
        title: item.title ?? definition.title,
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
