import type { LocalDeviceApp, LocalDeviceSkill } from './runtime-composer-catalog'

export function catalogRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid composer catalog record')
  return value as Record<string, unknown>
}

export function catalogArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid composer catalog list')
  return value
}

export function catalogString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Invalid composer catalog identifier')
  return value
}

function optionalText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Invalid composer catalog text')
  return value
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== 'boolean') throw new Error('Invalid composer catalog flag')
  return value
}

export function decodeCodexComposerApps(value: unknown): LocalDeviceApp[] {
  return catalogArray(value).map(item => {
    const app = catalogRecord(item)
    return {
      id: catalogString(app.id),
      name: catalogString(app.name),
      description: optionalText(app.description),
      logoUrl: optionalText(app.logoUrl),
      installUrl: optionalText(app.installUrl),
      isAccessible: optionalBoolean(app.isAccessible),
      isEnabled: optionalBoolean(app.isEnabled),
      pluginDisplayNames:
        app.pluginDisplayNames == null
          ? []
          : catalogArray(app.pluginDisplayNames).map(catalogString),
      source: 'codex-app',
    }
  })
}

/** Preserve the PC skill description precedence and permission filtering. */
export function decodeCodexComposerSkills(value: unknown): LocalDeviceSkill[] {
  return catalogArray(value).flatMap(item => {
    const entry = catalogRecord(item)
    if (entry.errors != null && catalogArray(entry.errors).length)
      throw new Error('The task skill catalog contains read errors')
    return catalogArray(entry.skills).flatMap(item => {
      const skill = catalogRecord(item)
      if (optionalBoolean(skill.enabled) === false) return []
      const metadata = skill.interface == null ? {} : catalogRecord(skill.interface)
      const description =
        optionalText(metadata.shortDescription) ||
        optionalText(metadata.short_description) ||
        optionalText(skill.shortDescription) ||
        optionalText(skill.short_description) ||
        null
      const scope = optionalText(skill.scope) ?? undefined
      return [
        {
          name: catalogString(skill.name),
          description: description || optionalText(skill.description) || '',
          short_description: description,
          path: catalogString(skill.path),
          source: 'codex',
          scope,
          source_label: null,
          source_priority: scope === 'system' || scope === 'admin' ? 1 : 0,
          origin: 'local',
        },
      ]
    })
  })
}

export async function listCodexComposerApps(
  request: (method: 'app/list', params: Record<string, unknown>) => Promise<unknown>,
  options: { includeInaccessible?: boolean; forceRefetch?: boolean } = {}
): Promise<LocalDeviceApp[]> {
  const apps: LocalDeviceApp[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const response = catalogRecord(
      await request('app/list', {
        cursor,
        limit: 100,
        forceRefetch: options.forceRefetch ?? false,
      })
    )
    apps.push(...decodeCodexComposerApps(response.data))
    cursor = optionalText(response.nextCursor)
    if (cursor && cursors.has(cursor)) throw new Error('Repeated app catalog cursor')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return apps.filter(
    app => app.isEnabled !== false && (options.includeInaccessible || app.isAccessible !== false)
  )
}
