import type { StandInBindingTarget, StandInExecutorApi } from '@/api/standIn'

export type StandInEntryError =
  | 'missing_identity'
  | 'conflict'
  | 'not_found'
  | 'forbidden'
  | 'ambiguous'
  | 'lookup_failed'
  | 'unsupported'

type StandInIdentityEntry = {
  kind: 'identity'
  deviceId?: string
  profileId?: string
  userId?: string
  settingsRequest?: string
  scheduled: boolean
}

export type StandInEntry =
  | { kind: 'home'; scheduled: boolean }
  | { kind: 'conversation'; deviceId: string; taskId: string; userId?: string }
  | StandInIdentityEntry
  | { kind: 'error'; error: StandInEntryError }

export type StandInEntryResult =
  | { kind: 'ready'; deviceId: string; profileId: string }
  | { kind: 'error'; error: StandInEntryError }

type BindingIdentity = Pick<StandInBindingTarget, 'userId' | 'deviceId'>
const ambiguous = Symbol('ambiguous')
type DeviceMatch = { deviceId: string; profileId: string } | typeof ambiguous | undefined

async function readDeviceMatch(
  api: Pick<StandInExecutorApi, 'personalGet'>,
  binding: BindingIdentity,
  deviceId: string,
  profileId: string | undefined,
  requireActive = false
): Promise<DeviceMatch> {
  const profile = await api.personalGet(binding.userId, deviceId)
  if (profile.userId !== binding.userId || profile.executionDeviceId !== deviceId)
    throw Object.assign(new Error('Stand-in profile does not match its owner or device'), {
      code: 'permission_denied',
    })
  if (requireActive && profile.lifecycle?.status) return undefined
  let match =
    (!profileId || profileId === '@primary') && deviceId === binding.deviceId
      ? '@primary'
      : undefined
  for (const role of profile.roles) {
    if (role.executionDeviceId !== deviceId || (profileId && role.id !== profileId)) continue
    if (match !== undefined) return ambiguous
    match = role.id
  }
  return match === undefined ? undefined : { deviceId, profileId: match }
}

export function parseStandInEntry(route: string): StandInEntry {
  const query = new URLSearchParams(route.split('?', 2)[1])
  const identityKeys = ['deviceId', 'profileId', 'settingsRequest', 'userId'] as const
  const conversationKeys = ['assistantDeviceId', 'assistantTaskId'] as const
  for (const key of [...identityKeys, ...conversationKeys, 'view']) {
    const values = query.getAll(key)
    if (values.length > 1 || values.some(value => !value || value !== value.trim()))
      return { kind: 'error', error: 'conflict' }
  }
  const read = (key: string) => query.get(key) ?? undefined
  const [deviceId, profileId, settingsRequest, userId] = identityKeys.map(read)
  const [conversationDeviceId, taskId] = conversationKeys.map(read)
  const view = read('view')
  if (view === 'messages' && !identityKeys.some(read) && !conversationKeys.some(read))
    return { kind: 'home', scheduled: false }
  if (view && view !== 'scheduled') return { kind: 'error', error: 'unsupported' }
  const scheduled = view === 'scheduled'
  if (conversationDeviceId || taskId) {
    if (!conversationDeviceId || !taskId || deviceId || profileId || settingsRequest || scheduled)
      return { kind: 'error', error: 'unsupported' }
    return { kind: 'conversation', deviceId: conversationDeviceId, taskId, userId }
  }
  if (!deviceId && !profileId) {
    if (settingsRequest || userId) return { kind: 'error', error: 'missing_identity' }
    return { kind: 'home', scheduled }
  }
  return { kind: 'identity', deviceId, profileId, userId, settingsRequest, scheduled }
}

export async function resolveStandInEntry(
  api: Pick<StandInExecutorApi, 'personalGet'>,
  entry: StandInIdentityEntry,
  binding: BindingIdentity,
  authorizedDeviceIds: ReadonlySet<string>,
  {
    unbound = false,
    verifyIndependentDevice,
  }: {
    unbound?: boolean
    verifyIndependentDevice?: (deviceId: string, profileId: string) => Promise<boolean>
  } = {}
): Promise<StandInEntryResult> {
  const { userId, deviceId, profileId } = entry
  const fail = (error: StandInEntryError) => ({ kind: 'error', error }) as const
  const ready = (deviceId: string, profileId: string) =>
    ({ kind: 'ready', deviceId, profileId }) as const
  if (userId && userId !== String(binding.userId)) return fail('forbidden')
  if (deviceId && (unbound || deviceId !== binding.deviceId) && !authorizedDeviceIds.has(deviceId))
    return fail('forbidden')
  if (unbound && !deviceId && profileId === '@primary') return fail('missing_identity')
  if (profileId === '@primary' && deviceId && deviceId !== binding.deviceId) return fail('conflict')

  try {
    // A stopped primary does not prevent work on a separate, verified active device.
    // Such a route must identify exactly one secondary role and must never discover a fallback.
    if (verifyIndependentDevice) {
      if (!deviceId || !profileId || profileId === '@primary' || deviceId === binding.deviceId)
        return fail('not_found')
      const match = await readDeviceMatch(api, binding, deviceId, profileId, true)
      if (match === ambiguous) return fail('ambiguous')
      if (!match || !(await verifyIndependentDevice(deviceId, profileId))) return fail('not_found')
      return ready(match.deviceId, match.profileId)
    }
    const namedDevice = profileId === '@primary' ? binding.deviceId : deviceId
    if (namedDevice) {
      const match = await readDeviceMatch(api, binding, namedDevice, profileId)
      if (match === ambiguous) return fail('ambiguous')
      if (match) return ready(match.deviceId, match.profileId)
      if (!profileId) return fail('not_found')
    }
    // The executor API reads profiles by device. An unscoped or mistargeted
    // profile needs every remaining authorized device checked for duplicates.
    const reads: Promise<DeviceMatch>[] = []
    if (binding.deviceId !== namedDevice)
      reads.push(readDeviceMatch(api, binding, binding.deviceId, profileId))
    for (const candidate of authorizedDeviceIds) {
      if (candidate !== binding.deviceId && candidate !== namedDevice)
        reads.push(readDeviceMatch(api, binding, candidate, profileId))
    }
    let match: Exclude<DeviceMatch, typeof ambiguous>
    for (const result of await Promise.all(reads)) {
      if (result === ambiguous || (result && match)) return fail('ambiguous')
      if (result) match = result
    }
    if (!match) return fail('not_found')
    if (deviceId) return fail('conflict')
    return ready(match.deviceId, match.profileId)
  } catch (cause) {
    const error = cause as { code?: string; status?: number; statusCode?: number } | null
    const forbidden =
      ['permission_denied', 'forbidden', 'unauthorized', 'http_401', 'http_403'].includes(
        error?.code ?? ''
      ) || [401, 403].includes(error?.status ?? error?.statusCode ?? 0)
    return fail(forbidden ? 'forbidden' : 'lookup_failed')
  }
}
