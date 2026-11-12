import type { InstalledPlugin } from '@/types/api'

export type PluginSettingsUpdate = Partial<
  Pick<InstalledPlugin['spec'], 'enabled' | 'componentStates' | 'updatePolicy'>
>

export class ExpiredPluginSettingsRequest extends Error {
  constructor() {
    super('Plugin settings request is no longer current')
    this.name = 'ExpiredPluginSettingsRequest'
  }
}

const pendingFields = new Map<string, symbol>()

export function restorePluginComponentState(
  current: Record<string, boolean> | undefined,
  previous: Record<string, boolean>,
  key: string
): Record<string, boolean> {
  const states = { ...current }
  if (Object.hasOwn(previous, key)) states[key] = previous[key]
  else delete states[key]
  return states
}

/** Order writes per field, so an unrelated component never cancels a valid update. */
export function beginPluginSettingsRequest(
  scope: string,
  id: string | number,
  update: PluginSettingsUpdate,
  scopeIsCurrent: () => boolean
) {
  const token = Symbol('plugin-settings-request')
  const fields = [
    ...(update.enabled !== undefined ? ['enabled'] : []),
    ...(update.updatePolicy !== undefined ? ['updatePolicy'] : []),
    ...Object.keys(update.componentStates ?? {}).map(key => `component:${key}`),
  ]
  const identity = (field: string) => JSON.stringify([scope, String(id), field])
  for (const field of fields) pendingFields.set(identity(field), token)
  const current = (field: string) =>
    scopeIsCurrent() && pendingFields.get(identity(field)) === token
  return {
    isCurrent: () => scopeIsCurrent() && (!fields.length || fields.some(current)),
    currentUpdate: (): PluginSettingsUpdate => ({
      ...(current('enabled') ? { enabled: update.enabled } : {}),
      ...(current('updatePolicy') ? { updatePolicy: update.updatePolicy } : {}),
      ...(update.componentStates
        ? {
            componentStates: Object.fromEntries(
              Object.entries(update.componentStates).filter(([key]) => current(`component:${key}`))
            ),
          }
        : {}),
    }),
    finish: () => {
      for (const field of fields) {
        if (pendingFields.get(identity(field)) === token) pendingFields.delete(identity(field))
      }
    },
  }
}
