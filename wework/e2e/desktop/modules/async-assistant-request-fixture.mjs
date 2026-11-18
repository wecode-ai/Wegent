import { isDeepStrictEqual } from 'node:util'

export function assistantRequestIdentity(request) {
  if (!request) return null
  const identifier = value =>
    typeof value === 'string' && /^[\w.:@-]{1,128}$/.test(value) ? value : null
  return {
    ...Object.fromEntries(
      [
        'requestId',
        'deviceId',
        'runtimeTaskId',
        'conversationId',
        'executionId',
        'state',
        'reasonCode',
      ].map(field => [field, identifier(request[field])])
    ),
    ownerUserId: Number.isSafeInteger(request.ownerUserId) ? request.ownerUserId : null,
  }
}

export function matchesAssistantRequestGrant(declaration, saved) {
  const role = declaration?.version === 1 && declaration.roles?.find(row => row.id === '@primary')
  const scope = saved.primary.collaboration
  return Boolean(
    role &&
    role.userId === saved.userId &&
    role.version === saved.version &&
    role.enabled === true &&
    role.collaboration?.enabled === true &&
    role.collaboration.allProjects === scope.allProjects &&
    isDeepStrictEqual(role.collaboration.projects, scope.projects) &&
    isDeepStrictEqual(role.collaboration.excludedProjects, scope.excludedProjects) &&
    isDeepStrictEqual(role.collaboration.tags, scope.tags) &&
    isDeepStrictEqual(role.collaboration.policy, {
      automatic: scope.policy.automatic,
      askBeforeAct: scope.policy.askBeforeAct,
    })
  )
}

export async function waitForAssistantRequestGrant({
  environment,
  deviceName,
  saved,
  until,
  observe,
}) {
  return until(
    async () => {
      // The request endpoint reads this durable grant, not the local settings or online cache.
      const rows = await environment.queryDatabase(
        `SELECT JSON_EXTRACT(json, '$.spec.personalAssistantDispatch') AS declaration
         FROM kinds WHERE user_id = %s AND kind = 'Device' AND namespace = 'default'
         AND name = %s AND is_active = 1`,
        [saved.userId, deviceName]
      )
      const value = rows[0]?.declaration
      const declaration = typeof value === 'string' ? JSON.parse(value) : (value ?? null)
      observe(declaration)
      return declaration
    },
    declaration => matchesAssistantRequestGrant(declaration, saved),
    'The server must observe the saved default assistant authorization before accepting requests'
  )
}

export async function restorePersonalStandInProfile(rpc, userId, original) {
  const current = await rpc('runtime.stand_in.personal.get', { userId })
  return rpc('runtime.stand_in.personal.save', {
    userId,
    settings: { ...original, version: current.version },
  })
}

export async function cleanupAssistantRequestFixture(actions, verificationError) {
  const cleanupErrors = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length) {
    const errors = verificationError ? [verificationError, ...cleanupErrors] : cleanupErrors
    throw new AggregateError(
      errors,
      `Assistant request verification or cleanup failed: ${errors.map(error => error.message).join('; ')}`
    )
  }
}
