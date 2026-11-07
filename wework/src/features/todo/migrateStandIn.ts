import { dequal } from 'dequal'
import { newStandInRole, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'

export class StandInMigrationError extends Error {
  readonly code: 'changed' | 'conflict' | 'same_device'
  constructor(code: 'changed' | 'conflict' | 'same_device') {
    super(code)
    this.code = code
  }
}

/** Copy portable settings and role-visible memories before pausing the local intake. */
export async function migrateStandIn(
  api: StandInExecutorApi,
  input: {
    sourceUser: number
    sourceDevice: string
    roleId?: string
    targetUser: number
    targetDevice: string
    primaryName: string
  }
): Promise<StandInRole> {
  const { sourceUser, sourceDevice, roleId, targetUser, targetDevice } = input
  if (sourceDevice === targetDevice) throw new StandInMigrationError('same_device')
  const [source, memories, target] = await Promise.all([
    api.personalGet(sourceUser, sourceDevice),
    api.memories(sourceUser, sourceDevice),
    api.personalGet(targetUser, targetDevice),
  ])
  const original = roleId ? source.roles.find(role => role.id === roleId) : source.primary
  if (!original) throw new StandInMigrationError('changed')
  const key = JSON.stringify([sourceDevice, sourceUser, roleId ?? '@primary'])
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const id = `migrated-${Array.from(new Uint8Array(bytes), byte =>
    byte.toString(16).padStart(2, '0')
  )
    .join('')
    .slice(0, 48)}`
  const role = roleId ? source.roles.find(role => role.id === roleId)! : undefined
  const prompt = [source.primary?.prompt, source.primary?.preferences, role?.prompt]
    .filter(Boolean)
    .join('\n\n')
  const migrated: StandInRole = {
    ...newStandInRole(targetDevice, id),
    name: role?.name || input.primaryName,
    prompt,
    model: original.model,
    modelOptions: original.modelOptions,
    migrationSource: key,
  }
  migrated.collaboration = {
    ...migrated.collaboration,
    allProjects: false,
    tags: role?.collaboration.tags ?? [],
  }
  const existing = target.roles.find(role => role.id === id)
  if (
    existing &&
    (existing.migrationSource !== key ||
      !dequal(
        [
          existing.name,
          existing.prompt,
          existing.model,
          existing.modelOptions,
          existing.collaboration.tags,
        ],
        [
          migrated.name,
          migrated.prompt,
          migrated.model,
          migrated.modelOptions,
          migrated.collaboration.tags,
        ]
      ))
  )
    throw new StandInMigrationError('conflict')
  if (!existing)
    await api.personalSave(
      targetUser,
      { ...target, roles: [...target.roles, migrated] },
      targetDevice
    )
  const imported = await api.memories(targetUser, targetDevice)
  for (const memory of memories.filter(
    memory =>
      memory.scope.kind === 'personal' ||
      (memory.scope.kind === 'role' && memory.scope.roleId === roleId)
  )) {
    if (
      imported.some(
        row =>
          row.scope.kind === 'role' && row.scope.roleId === id && row.content === memory.content
      )
    )
      continue
    imported.push(
      await api.saveMemory(targetUser, targetDevice, {
        content: memory.content,
        scope: { kind: 'role', roleId: id },
      })
    )
  }
  const current = await api.personalGet(sourceUser, sourceDevice)
  if (current.version !== source.version) throw new StandInMigrationError('changed')
  // History, memories, source bindings and already running work remain on their original device.
  await api.personalSave(
    sourceUser,
    {
      ...current,
      ...(roleId
        ? {
            roles: current.roles.map(role =>
              role.id === roleId ? { ...role, enabled: false } : role
            ),
          }
        : { primary: { ...current.primary!, enabled: false } }),
    },
    sourceDevice
  )
  return existing ?? migrated
}
