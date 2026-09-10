import { createHmac } from 'node:crypto'

const USER_ID_PREFIX = 'wework-user:'

export class IdentityError extends Error {
  constructor(code) {
    super('Telemetry identity unavailable')
    this.name = 'IdentityError'
    this.code = code
  }
}

export function deriveDistinctId(user, identityHmacKey) {
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || !nonEmptyString(identityHmacKey)) {
    throw new IdentityError('identity_unavailable')
  }

  const digest = createHmac('sha256', identityHmacKey)
    .update(`${USER_ID_PREFIX}${user.id}`)
    .digest('hex')
  return `wework:${digest}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}
