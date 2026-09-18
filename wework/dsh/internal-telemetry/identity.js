import { createHmac } from 'node:crypto'

const USER_ID_PREFIX = 'wework-user:'

export class IdentityError extends Error {
  constructor(code) {
    super('Telemetry identity unavailable')
    this.name = 'IdentityError'
    this.code = code
  }
}

export function deriveDistinctId(identity, identityHmacKey) {
  if (isEmailPrefix(identity?.emailPrefix)) {
    return identity.emailPrefix
  }

  if (!Number.isSafeInteger(identity?.id) || identity.id <= 0 || !nonEmptyString(identityHmacKey)) {
    throw new IdentityError('identity_unavailable')
  }

  const digest = createHmac('sha256', identityHmacKey)
    .update(`${USER_ID_PREFIX}${identity.id}`)
    .digest('hex')
  return `wework:${digest}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isEmailPrefix(value) {
  return nonEmptyString(value) && value.length <= 128 && !/\s/.test(value) && !value.includes('@')
}
