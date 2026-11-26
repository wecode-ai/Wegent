import { useState, useSyncExternalStore } from 'react'
import { useDOMEvent } from '../dom-events'
import {
  createComposerCatalogResource,
  type ComposerCatalogEvents,
  type ComposerCatalogSources,
} from './composerCatalogResource'

export type { ComposerCatalogStore, ComposerCatalogEvents } from './composerCatalogResource'

export function useComposerCatalog<Skill, App>({
  onListLocalSkills,
  onListLocalApps,
  appsStore,
  events,
  isMenuOpen,
}: ComposerCatalogSources<Skill, App> & {
  events: ComposerCatalogEvents
  isMenuOpen(): boolean
}) {
  const sources = { onListLocalSkills, onListLocalApps, appsStore }
  const [scope, setScope] = useState(() => ({
    ...sources,
    resource: createComposerCatalogResource(sources),
  }))
  if (
    scope.appsStore !== appsStore ||
    scope.onListLocalApps !== onListLocalApps ||
    scope.onListLocalSkills !== onListLocalSkills
  ) {
    setScope({
      ...sources,
      resource: createComposerCatalogResource(
        sources,
        isMenuOpen() ||
          (scope.appsStore === appsStore &&
            (scope.resource.getSnapshot().loading || scope.resource.getSnapshot().appsLoading))
      ),
    })
  }
  const { resource } = scope
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  useDOMEvent('window', events.requestSync ?? '', resource.publishApps, {
    enabled: !!events.requestSync,
  })
  useDOMEvent('window', events.catalogChanged ?? '', () => resource.invalidate(isMenuOpen()), {
    enabled: !!events.catalogChanged,
  })
  return {
    ...snapshot,
    loadLocalApps: resource.loadLocalApps,
    loadLocalMentions: resource.loadLocalMentions,
  }
}
