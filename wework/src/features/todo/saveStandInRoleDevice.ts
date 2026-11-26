import { PersonalAssistantSavePreflightError } from './personalAssistantDeviceSettings'
import { dequal } from 'dequal'
import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'

import { checkTargetConnectionProviders, transferredConnection } from './standInConnectionTransfer'

/** Stage the target before redirecting new intake; old tasks retain their source configuration. */
export async function saveStandInRoleDevice(
  api: StandInExecutorApi,
  input: {
    userId: number
    sourceDevice: string
    source: PersonalStandInSettings
    draft: PersonalStandInSettings
    role: StandInRole
    definitionChange?: Parameters<StandInExecutorApi['personalSave']>[4]
  }
): Promise<StandInRole> {
  const { userId, sourceDevice, source, draft, role } = input
  const targetDevice = role.executionDeviceId
  const target = await api.personalGet(userId, targetDevice, { deviceSettingsOnly: true })
  if (target.executionDeviceId === source.executionDeviceId) {
    const [sourceIdentity, targetIdentity] = await Promise.all([
      api.deviceIdentity(sourceDevice),
      api.deviceIdentity(targetDevice),
    ])
    if (sourceIdentity.backendDeviceId === targetIdentity.backendDeviceId) {
      const result = await api.personalSave(
        userId,
        {
          ...draft,
          roles: draft.roles.map(row =>
            row.id === role.id
              ? {
                  ...row,
                  previousExecutionDevices: [
                    ...new Set([...(row.previousExecutionDevices ?? []), sourceDevice]),
                  ],
                }
              : row
          ),
        },
        sourceDevice,
        undefined,
        input.definitionChange
      )
      return result.roles.find(row => row.id === role.id)!
    }
  }
  const migrationSource = role.migrationSource ?? JSON.stringify([sourceDevice, userId, role.id])
  const previous = source.roles.find(row => row.id === role.id)
  const existing = target.roles.find(row => row.id === role.id)
  const empty =
    existing &&
    !existing.enabled &&
    !existing.name &&
    !existing.prompt &&
    !existing.connections?.length &&
    existing.version === 0
  if (existing && !empty && existing.migrationSource !== migrationSource) {
    throw Object.assign(
      new Error('The target already contains a different role with this identity'),
      {
        code: 'stand_in_role_device_conflict',
      }
    )
  }
  const carryTeam = previous && previous.teamRef === role.teamRef
  const current = await api.personalGet(
    userId,
    sourceDevice,
    carryTeam ? { exportTeamRoleId: role.id } : undefined
  )
  if (current.version !== source.version || !dequal(current.roles, source.roles)) {
    throw Object.assign(new Error('The source profile changed'), { code: 'version_conflict' })
  }
  const transferred: StandInRole = {
    ...role,
    migrationSource,
    previousExecutionDevices: [
      ...new Set(previous ? [...(previous.previousExecutionDevices ?? []), sourceDevice] : []),
    ].filter(device => device !== targetDevice),
  }
  delete transferred.taskPermissions
  if (current.portableTeam) transferred.teamRef = null
  await checkTargetConnectionProviders(api, targetDevice, role.connections)
  const staged = await api.personalSave(
    userId,
    {
      ...target,
      roles: [
        ...target.roles.filter(row => row.id !== role.id),
        { ...transferred, enabled: false },
      ],
    },
    targetDevice,
    role.id,
    undefined,
    current.portableTeam
  )
  // Webhook subscriptions are addressed to one Executor. Transfer ownership only
  // after redirecting the source, using the generation checked by the cloud.
  const connections = staged.roles
    .find(row => row.id === role.id)
    ?.connections?.map(transferredConnection)
  let redirected: PersonalStandInSettings | undefined
  try {
    redirected = previous
      ? await api.personalSave(
          userId,
          {
            ...draft,
            roles: draft.roles.map(row =>
              row.id === role.id
                ? { ...previous, executionDeviceId: targetDevice, migrationSource }
                : row
            ),
          },
          sourceDevice
        )
      : await api.saveDelegationRoute(userId, sourceDevice, source.version, role.id, {
          id: role.id,
          name: role.name,
          prompt: role.prompt,
          enabled: role.enabled,
          executionDeviceId: targetDevice,
        })
    const result = await api.personalSave(
      userId,
      {
        ...staged,
        cloudDefinitionRevision: target.cloudDefinitionRevision,
        roles: staged.roles.map(row =>
          row.id === role.id
            ? {
                ...row,
                enabled: role.enabled,
                connections,
              }
            : row
        ),
      },
      targetDevice,
      role.id,
      input.definitionChange
    )
    return result.roles.find(row => row.id === role.id)!
  } catch (cause) {
    if (redirected) {
      try {
        if (!(cause instanceof PersonalAssistantSavePreflightError)) {
          const observed = await api.personalGet(userId, targetDevice)
          if (
            connections?.some(connection => connection.pendingTakeover) ||
            observed.roles.some(row => row.id === role.id && row.enabled)
          ) {
            // An activation can commit before its response is lost. Never restore two receivers.
            throw new Error('Target activation is not known to have failed', { cause })
          }
        }
        // Use the committed version so compensation cannot overwrite another edit.
        if (previous) {
          const latest = await api.personalGet(userId, sourceDevice)
          await api.personalSave(
            userId,
            {
              ...latest,
              version: redirected.version,
              roles: latest.roles.map(row => (row.id === role.id ? previous : row)),
            },
            sourceDevice
          )
        } else {
          const priorRoute = source.delegationRoutes?.find(row => row.id === role.id)
          await api.saveDelegationRoute(
            userId,
            sourceDevice,
            redirected.version,
            role.id,
            priorRoute ?? null
          )
        }
      } catch (recoveryError) {
        throw Object.assign(
          new Error('Refresh the target role to reconcile the device change', {
            cause: new AggregateError([cause, recoveryError], 'Role device change recovery failed'),
          }),
          { code: 'stand_in_role_device_incomplete' }
        )
      }
    }
    throw cause
  }
}
