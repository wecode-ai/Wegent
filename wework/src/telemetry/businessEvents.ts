import type { AnalyticsEvent, AnalyticsEventMap } from './events'

type PluginEventName =
  | 'plugin_center_opened'
  | 'plugin_installed'
  | 'plugin_uninstalled'
  | 'plugin_enabled_changed'
  | 'operation_failed'

const listeners = new Set<(event: AnalyticsEvent) => void>()

export function trackPluginEvent<Name extends PluginEventName>(
  name: Name,
  properties: AnalyticsEventMap[Name]
): void {
  for (const listener of listeners) {
    try {
      listener({ name, properties } as AnalyticsEvent)
    } catch {
      // Observers must not change the business result.
    }
  }
}

export function subscribeBusinessEvents(listener: (event: AnalyticsEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
