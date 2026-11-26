import { dequal } from 'dequal'
import { newStandInRole, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'

import { checkTargetConnectionProviders, transferredConnection } from './standInConnectionTransfer'

export class StandInMigrationError extends Error {
  readonly code: 'changed' | 'conflict' | 'same_device' | 'not_stopped'
  constructor(code: 'changed' | 'conflict' | 'same_device' | 'not_stopped') {
    super(code)
    this.code = code
  }
}

/** Copy portable settings and role-visible memories only after the entire source stopped. */
export async function migrateStandIn(
  api: StandInExecutorApi,
  input: {
    sourceUser: number
    sourceDevice: string
    roleId?: string
    targetUser: number
    targetDevice: string
    targetApi?: StandInExecutorApi
    primaryName: string
    assertOwnership?(): void
  }
): Promise<StandInRole> {
  input.assertOwnership?.()
  const { sourceUser, sourceDevice, roleId, targetUser, targetDevice } = input
  const targetApi = input.targetApi ?? api
  if (sourceDevice === targetDevice) throw new StandInMigrationError('same_device')
  const [source, memories, target] = await Promise.all([
    api.personalGet(sourceUser, sourceDevice, { exportTeamRoleId: roleId ?? '@primary' }),
    api.memories(sourceUser, sourceDevice),
    targetApi.personalGet(targetUser, targetDevice, { deviceSettingsOnly: true }),
  ])
  if (source.lifecycle?.status !== 'stopped') throw new StandInMigrationError('not_stopped')
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
  const prompt = [source.primary?.prompt, role?.prompt].filter(Boolean).join('\n\n')
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
  if (existing && source.portableTeam) {
    const restored = await targetApi.personalGet(targetUser, targetDevice, {
      deviceSettingsOnly: true,
      exportTeamRoleId: existing.id,
    })
    if (!dequal(restored.portableTeam, source.portableTeam)) {
      throw new StandInMigrationError('conflict')
    }
  }
  input.assertOwnership?.()
  if (!existing) {
    if (sourceUser === targetUser && original.connections?.length) {
      await checkTargetConnectionProviders(api, targetDevice, original.connections)
      migrated.connections = original.connections.map(transferredConnection)
    }
    input.assertOwnership?.()
  }
  let destinationRole = existing
  if (!existing || targetApi !== api) {
    const saved = await targetApi.personalSave(
      targetUser,
      { ...target, roles: existing ? target.roles : [...target.roles, migrated] },
      targetDevice,
      source.portableTeam ? id : undefined,
      { kind: 'create', roleId: id },
      source.portableTeam
    )
    destinationRole = saved.roles.find(row => row.id === id)
  }
  if (!destinationRole) throw new StandInMigrationError('changed')
  input.assertOwnership?.()
  const imported = await api.memories(targetUser, targetDevice)
  for (const memory of memories.filter(
    memory =>
      !memory.evidenceUnavailable &&
      !memory.evidence?.trainingCase &&
      (memory.scope.kind === 'personal' ||
        (memory.scope.kind === 'role' && memory.scope.roleId === roleId))
  )) {
    if (
      imported.some(
        row =>
          row.scope.kind === 'role' && row.scope.roleId === id && row.content === memory.content
      )
    )
      continue
    input.assertOwnership?.()
    imported.push(
      await api.saveMemory(targetUser, targetDevice, {
        content: memory.content,
        scope: { kind: 'role', roleId: id },
      })
    )
  }
  input.assertOwnership?.()
  const current = await api.personalGet(sourceUser, sourceDevice)
  if (current.version !== source.version) throw new StandInMigrationError('changed')
  if (current.lifecycle?.status !== 'stopped') throw new StandInMigrationError('not_stopped')
  input.assertOwnership?.()
  // History, memories and device grants remain on the stopped source. Never restart it here.
  return destinationRole
}
