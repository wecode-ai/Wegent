import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { dequal } from 'dequal'

export class PersonalAssistantSavePreflightError extends Error {}

export class PersonalAssistantDefinitionSaveError extends Error {
  readonly code = 'cloud_definition_save_unconfirmed'
  readonly saved: PersonalStandInSettings

  constructor(saved: PersonalStandInSettings, cause: unknown) {
    super('The device settings were saved but the cloud assistant definition was not confirmed', {
      cause,
    })
    this.saved = saved
  }
}

function applyDefinitions(settings: PersonalStandInSettings, account: PersonalAssistantAccount) {
  const definitions = new Map(
    account.definitions.map(definition => [definition.roleId, definition])
  )
  const primary = definitions.get('@primary')
  const roles = new Map(settings.roles.map(role => [role.id, role]))
  for (const [id, definition] of definitions) {
    if (id === '@primary') continue
    const existing = roles.get(id) ?? newStandInRole(settings.executionDeviceId, id)
    roles.set(id, {
      ...existing,
      executionDeviceId:
        definition.bot.spec?.execution_policy?.environment_id ?? existing.executionDeviceId,
      name: definition.bot.metadata.displayName ?? existing.name,
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
        name: definition.bot.metadata.displayName ?? '',
        prompt: definition.ghost.spec.systemPrompt,
      },
    ])
  )
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
  publish: (account: PersonalAssistantAccount) => void
): WorkbenchServices {
  const executor = services.standInApi
  const cloud = services.personalAssistantAccountApi
  if (!executor || !cloud) return services
  return {
    ...services,
    standInApi: {
      ...executor,
      async personalGet(userId, deviceId, options) {
        const settings = await executor.personalGet(userId, deviceId)
        const account = readAccount()
        if (!account) return settings
        return options?.deviceSettingsOnly
          ? { ...settings, cloudDefinitionRevision: account.revision }
          : applyDefinitions(settings, account)
      },
      async personalSave(userId, settings, deviceId, transferRoleId, definitionChange) {
        const { cloudDefinitionRevision, ...deviceSettings } = settings
        const account = readAccount()
        if (!account || (transferRoleId && !definitionChange)) {
          return executor.personalSave(userId, deviceSettings, deviceId, transferRoleId)
        }
        if (cloudDefinitionRevision !== account.revision) {
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
        const configured = new Set(device.roles.map(role => role.id))
        const projectedSettings = applyDefinitions(device, account)
        const projected = new Map(projectedSettings.roles.map(role => [role.id, role]))
        const localRoles = settings.roles.filter(role => {
          const original = projected.get(role.id)
          return (
            configured.has(role.id) ||
            !original ||
            !dequal(role, { ...original, prompt: role.prompt, name: role.name })
          )
        })
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
            roles: localRoles,
          },
          deviceId,
          transferRoleId
        )
        const definitions = updateDefinitionInputs(account, settings, definitionChange)
        if (matchesDefinitions(account, definitions)) return applyDefinitions(saved, account)
        try {
          const current = await cloud.updateDefinitions(account.revision, [...definitions.values()])
          publish(current)
          return applyDefinitions(saved, current)
        } catch (cause) {
          const latest = await cloud.get().catch(() => null)
          if (latest) {
            publish(latest)
            if (matchesDefinitions(latest, definitions)) return applyDefinitions(saved, latest)
          }
          throw new PersonalAssistantDefinitionSaveError(applyDefinitions(saved, account), cause)
        }
      },
    },
  }
}
