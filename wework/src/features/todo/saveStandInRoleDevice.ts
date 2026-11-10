import { dequal } from 'dequal'
import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'

/** Stage the target before redirecting new intake; old tasks retain their source configuration. */
export async function saveStandInRoleDevice(
  api: StandInExecutorApi,
  input: {
    userId: number
    sourceDevice: string
    source: PersonalStandInSettings
    draft: PersonalStandInSettings
    role: StandInRole
  }
): Promise<StandInRole> {
  const { userId, sourceDevice, source, draft, role } = input
  const targetDevice = role.executionDeviceId
  const target = await api.personalGet(userId, targetDevice)
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
        sourceDevice
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
  const current = await api.personalGet(userId, sourceDevice)
  if (current.version !== source.version || !dequal(current.roles, source.roles)) {
    throw Object.assign(new Error('The source profile changed'), { code: 'version_conflict' })
  }
  const transferred: StandInRole = {
    ...role,
    migrationSource,
    previousExecutionDevices: [
      ...new Set([...(previous?.previousExecutionDevices ?? []), sourceDevice]),
    ].filter(device => device !== targetDevice),
  }
  const staged = await api.personalSave(
    userId,
    {
      ...target,
      roles: [
        ...target.roles.filter(row => row.id !== role.id),
        { ...transferred, enabled: false },
      ],
    },
    targetDevice
  )
  let redirected: PersonalStandInSettings | undefined
  try {
    redirected = await api.personalSave(
      userId,
      {
        ...draft,
        roles: draft.roles.map(row =>
          row.id === role.id
            ? {
                ...(previous ?? row),
                executionDeviceId: targetDevice,
                migrationSource,
              }
            : row
        ),
      },
      sourceDevice
    )
    const result = await api.personalSave(
      userId,
      {
        ...staged,
        roles: staged.roles.map(row => (row.id === role.id ? transferred : row)),
      },
      targetDevice
    )
    return result.roles.find(row => row.id === role.id)!
  } catch (cause) {
    if (redirected) {
      try {
        const observed = await api.personalGet(userId, targetDevice)
        if (observed.roles.some(row => row.id === role.id && row.enabled)) {
          // An activation can commit before its response is lost. Never restore two receivers.
          throw new Error('Target activation is not known to have failed', { cause })
        }
        // Use the committed version so compensation cannot overwrite another edit.
        await api.personalSave(userId, { ...source, version: redirected.version }, sourceDevice)
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
