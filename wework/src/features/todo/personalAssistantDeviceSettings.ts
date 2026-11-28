import { ApiError } from '@/api/http'
import {
  assistantDefinitionName,
  type PersonalAssistantAccount,
} from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  commitLocalStorageValue,
  readCommittedLocalStorageValue,
} from '@/desktop/localStoragePersistence'
import { reportStandInError } from '@/lib/stand-in-error-message'
import { dequal } from 'dequal'

export class PersonalAssistantSavePreflightError extends Error {}

export class PersonalAssistantDefinitionSaveError extends Error {
  readonly code: 'cloud_definition_save_unconfirmed' | 'cloud_definition_version_conflict'
  readonly saved: PersonalStandInSettings

  constructor(saved: PersonalStandInSettings, cause: unknown, conflict = false) {
    super('The device settings were saved but the cloud assistant definition was not confirmed', {
      cause,
    })
    this.saved = saved
    this.code = conflict ? 'cloud_definition_version_conflict' : 'cloud_definition_save_unconfirmed'
  }
}

function definitionBackupPrefix(backendUrl: string, userId: number) {
  return `wework.assistant-definition-backups.${JSON.stringify([backendUrl, userId])}.`
}

export function collectPersonalAssistantDefinitionBackups(backendUrl: string, userId: number) {
  const prefix = definitionBackupPrefix(backendUrl, userId)
  const backups: unknown[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const value = localStorage.getItem(key)
    if (value !== null) backups.push(JSON.parse(value) as unknown)
  }
  return backups
}

async function preserveConflictingDefinitions(
  settings: PersonalStandInSettings,
  account: PersonalAssistantAccount,
  backendUrl: string,
  userId: number,
  isKnownDevice: (id: string) => boolean
) {
  const cloud = definitionInputs(account)
  const primary = cloud.get('@primary')
  const retired = new Set(account.retiredRoleIds)
  const roles = settings.roles
    .filter(role => {
      const definition = cloud.get(role.id)
      return definition
        ? definition.name !== role.name ||
            definition.prompt !== role.prompt ||
            role.executionDeviceId !==
              (definition.executionDeviceId ??
                primary?.executionDeviceId ??
                settings.executionDeviceId) ||
            !isKnownDevice(role.executionDeviceId)
        : retired.has(role.id) || !isKnownDevice(role.executionDeviceId)
    })
    .map(({ id, name, prompt, executionDeviceId }) => ({
      roleId: id,
      name,
      prompt,
      executionDeviceId,
    }))
  if (settings.primary?.prompt && primary && primary.prompt !== settings.primary.prompt)
    roles.unshift({
      roleId: '@primary',
      name: primary.name,
      prompt: settings.primary.prompt,
      executionDeviceId: settings.executionDeviceId,
    })
  if (!roles.length) return
  const key =
    definitionBackupPrefix(backendUrl, userId) +
    JSON.stringify([settings.executionDeviceId, settings.version, account.revision])
  if (await readCommittedLocalStorageValue(key)) return
  await commitLocalStorageValue(
    key,
    JSON.stringify({
      sourceDeviceId: settings.executionDeviceId,
      profileVersion: settings.version,
      cloudRevision: account.revision,
      definitions: roles,
    })
  )
}

export function resolveAssistantExecutionDevice(
  configured: string | undefined,
  primary: string | undefined,
  current: string,
  isKnownDevice: (id: string) => boolean
): string {
  if (configured && isKnownDevice(configured)) return configured
  if (primary && isKnownDevice(primary)) return primary
  return current
}

function applyDefinitions(
  settings: PersonalStandInSettings,
  account: PersonalAssistantAccount,
  isKnownDevice: (id: string) => boolean,
  roleDirectory = false,
  bindingDevice?: string
) {
  const definitions = new Map(
    account.definitions.map(definition => [definition.roleId, definition])
  )
  const primary = definitions.get('@primary')
  const retired = new Set(account.retiredRoleIds)
  const roles = new Map(
    settings.roles
      .filter(
        role =>
          !retired.has(role.id) &&
          (definitions.has(role.id) || isKnownDevice(role.executionDeviceId))
      )
      .map(role => [role.id, role])
  )
  for (const [id, definition] of definitions) {
    if (id === '@primary' || (roleDirectory && !roles.has(id))) continue
    const existing = roles.get(id) ?? newStandInRole(settings.executionDeviceId, id)
    roles.set(id, {
      ...existing,
      executionDeviceId: resolveAssistantExecutionDevice(
        definition.bot.spec?.execution_policy?.environment_id,
        primary?.bot.spec?.execution_policy?.environment_id,
        bindingDevice ?? settings.executionDeviceId,
        isKnownDevice
      ),
      name: assistantDefinitionName(definition) ?? existing.name,
      prompt: definition.ghost.spec.systemPrompt,
    })
  }
  return {
    ...settings,
    cloudDefinitionRevision: account.revision,
    primary:
      primary && (settings.primary || primary.ghost.spec.systemPrompt)
        ? {
            enabled: true,
            preferences: '',
            ...settings.primary,
            prompt: primary.ghost.spec.systemPrompt,
          }
        : settings.primary,
    roles: [...roles.values()],
  }
}

function definitionInputs(account: PersonalAssistantAccount) {
  return new Map(
    account.definitions.map(definition => [
      definition.roleId,
      {
        roleId: definition.roleId,
        executionDeviceId: definition.bot.spec?.execution_policy?.environment_id,
        name: assistantDefinitionName(definition) ?? '',
        prompt: definition.ghost.spec.systemPrompt,
      },
    ])
  )
}

export async function initializePersonalAssistantOnDevice(
  api: NonNullable<WorkbenchServices['personalAssistantAccountApi']>,
  name: string,
  deviceId: string
) {
  const account = (await api.get()) ?? (await api.initialize(name, undefined, deviceId))
  const definitions = definitionInputs(account)
  const primary = definitions.get('@primary')
  if (!primary || primary.executionDeviceId === deviceId) return account
  primary.executionDeviceId = deviceId
  return api.updateDefinitions(account.revision, [...definitions.values()])
}

function matchesDefinitions(
  account: PersonalAssistantAccount,
  wanted: ReturnType<typeof definitionInputs>
) {
  const current = definitionInputs(account)
  return (
    wanted.size === current.size &&
    [...wanted.values()].every(({ roleId, name, prompt, executionDeviceId }) => {
      const definition = current.get(roleId)
      return (
        definition?.name === name &&
        definition.prompt === prompt &&
        definition.executionDeviceId === executionDeviceId
      )
    })
  )
}

function updateDefinitionInputs(
  account: PersonalAssistantAccount,
  settings: PersonalStandInSettings,
  change: Parameters<StandInExecutorApi['personalSave']>[4]
) {
  const definitions = definitionInputs(account)
  if (!change) {
    const primary = definitions.get('@primary')
    if (primary && settings.primary) primary.prompt = settings.primary.prompt
  } else if (change.kind === 'delete') {
    definitions.delete(change.roleId)
  } else {
    const role = settings.roles.find(role => role.id === change.roleId)
    if (
      role &&
      (definitions.has(role.id) ||
        (change.kind === 'create' && !account.retiredRoleIds.includes(role.id)))
    ) {
      definitions.set(role.id, {
        roleId: role.id,
        name: role.name,
        prompt: role.prompt,
        executionDeviceId: role.executionDeviceId,
      })
    }
  }
  return definitions
}

export function personalAssistantDeviceSettings(
  services: WorkbenchServices,
  readAccount: () => PersonalAssistantAccount | undefined,
  publish: (account: PersonalAssistantAccount) => void,
  backendUrl = '',
  isKnownDevice: (id: string) => boolean = () => true,
  bindingDevice?: string
): WorkbenchServices {
  const executor = services.standInApi
  const cloud = services.personalAssistantAccountApi
  if (!executor || !cloud) return services
  let unresolvedDefinitionRevision: string | undefined
  const syncDefinitions = async (
    account: PersonalAssistantAccount,
    saved: PersonalStandInSettings,
    definitions: ReturnType<typeof definitionInputs>
  ) => {
    if (matchesDefinitions(account, definitions))
      return applyDefinitions(saved, account, isKnownDevice, false, bindingDevice)
    try {
      const updated = await cloud.updateDefinitions(account.revision, [...definitions.values()])
      publish(updated)
      return applyDefinitions(saved, updated, isKnownDevice, false, bindingDevice)
    } catch (cause) {
      const latest = await cloud.get().catch(() => null)
      const conflict =
        (cause instanceof ApiError && cause.status === 409) ||
        Boolean(latest && latest.revision !== account.revision)
      if (latest) {
        publish(latest)
        if (matchesDefinitions(latest, definitions))
          return applyDefinitions(saved, latest, isKnownDevice, false, bindingDevice)
      }
      if (conflict && (!latest || latest.revision === account.revision)) {
        unresolvedDefinitionRevision = account.revision
      }
      throw new PersonalAssistantDefinitionSaveError(
        applyDefinitions(saved, latest ?? account, isKnownDevice, false, bindingDevice),
        cause,
        conflict
      )
    }
  }
  return {
    ...services,
    standInApi: {
      ...executor,
      async resolveProposal(userId, deviceId, proposalId, accept, undoVersion) {
        const account = readAccount()
        if (!accept || !account)
          return executor.resolveProposal(userId, deviceId, proposalId, accept, undoVersion)
        const before = await executor.personalGet(userId, deviceId)
        const saved = await executor.resolveProposal(
          userId,
          deviceId,
          proposalId,
          accept,
          undoVersion
        )
        const definitions = definitionInputs(account)
        const primary = definitions.get('@primary')
        if (primary && saved.primary && before.primary?.prompt !== saved.primary.prompt)
          primary.prompt = saved.primary.prompt
        const previous = new Map(before.roles.map(role => [role.id, role]))
        const retired = new Set(account.retiredRoleIds)
        for (const role of saved.roles) {
          const old = previous.get(role.id)
          previous.delete(role.id)
          const existing = definitions.get(role.id)
          if ((old && !existing) || (!old && existing)) continue
          if (retired.has(role.id) || (old?.name === role.name && old.prompt === role.prompt))
            continue
          definitions.set(role.id, {
            roleId: role.id,
            name: existing && old?.name === role.name ? existing.name : role.name,
            prompt: existing && old?.prompt === role.prompt ? existing.prompt : role.prompt,
            executionDeviceId: existing?.executionDeviceId ?? role.executionDeviceId,
          })
        }
        for (const id of previous.keys()) definitions.delete(id)
        return syncDefinitions(account, saved, definitions)
      },
      async personalGet(userId, deviceId, options) {
        const settings = await executor.personalGet(userId, deviceId)
        let account = readAccount()
        const unresolved = unresolvedDefinitionRevision
        if (unresolved !== undefined && !options?.deviceSettingsOnly) {
          if (account?.revision === unresolved) {
            const latest = await cloud.get()
            if (!latest) throw new Error('Cloud assistant definition is unavailable')
            const current = readAccount()
            if (current?.revision !== account.revision) account = current
            else {
              publish(latest)
              account = latest
            }
          }
          if (unresolvedDefinitionRevision === unresolved && account?.revision !== unresolved) {
            unresolvedDefinitionRevision = undefined
          }
        }
        if (!account) return settings
        await preserveConflictingDefinitions(
          settings,
          account,
          backendUrl,
          userId,
          isKnownDevice
        ).catch(cause => reportStandInError('backup-assistant-definition', cause, deviceId))
        return options?.deviceSettingsOnly
          ? { ...settings, cloudDefinitionRevision: account.revision }
          : applyDefinitions(
              settings,
              account,
              isKnownDevice,
              options?.roleDirectory,
              bindingDevice
            )
      },
      async personalSave(userId, settings, deviceId, transferRoleId, definitionChange) {
        const { cloudDefinitionRevision, ...deviceSettings } = settings
        const account = readAccount()
        if (!account || (transferRoleId && !definitionChange)) {
          return executor.personalSave(userId, deviceSettings, deviceId, transferRoleId)
        }
        if (
          cloudDefinitionRevision !== account.revision ||
          unresolvedDefinitionRevision === account.revision
        ) {
          throw Object.assign(
            new PersonalAssistantSavePreflightError('Cloud assistant definition changed'),
            {
              code: 'cloud_definition_version_conflict',
            }
          )
        }
        const device = await executor.personalGet(userId, deviceId).catch(cause => {
          if (!transferRoleId) throw cause
          throw new PersonalAssistantSavePreflightError('Unable to read the target assistant', {
            cause,
          })
        })
        await preserveConflictingDefinitions(device, account, backendUrl, userId, isKnownDevice)
        const configured = new Set(device.roles.map(role => role.id))
        const retired = new Set(account.retiredRoleIds)
        const projectedSettings = applyDefinitions(
          device,
          account,
          isKnownDevice,
          false,
          bindingDevice
        )
        const projected = new Map(projectedSettings.roles.map(role => [role.id, role]))
        const localRoles = settings.roles.filter(role => {
          if (retired.has(role.id)) return false
          const original = projected.get(role.id)
          return (
            configured.has(role.id) ||
            !original ||
            !dequal(role, { ...original, prompt: role.prompt, name: role.name })
          )
        })
        const hiddenRoles = device.roles
          .filter(role => !projected.has(role.id))
          .filter(role => role.id !== definitionChange?.roleId)
        const primary =
          definitionChange ||
          (!device.primary && dequal(settings.primary, projectedSettings.primary))
            ? device.primary
            : deviceSettings.primary
        // Keep the source grants and existing device-side workers on their owning Executor.
        const saved = await executor.personalSave(
          userId,
          {
            ...deviceSettings,
            primary,
            roles: [...localRoles, ...hiddenRoles],
          },
          deviceId,
          transferRoleId
        )
        return syncDefinitions(
          account,
          saved,
          updateDefinitionInputs(account, settings, definitionChange)
        )
      },
    },
  }
}
