export class IdentityError extends Error {
  constructor(code) {
    super('Telemetry identity unavailable')
    this.name = 'IdentityError'
    this.code = code
  }
}

export function deriveDistinctId(identity) {
  if (isEmailPrefix(identity?.emailPrefix)) {
    return identity.emailPrefix
  }

  throw new IdentityError('identity_unavailable')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isEmailPrefix(value) {
  return nonEmptyString(value) && value.length <= 128 && !/\s/.test(value) && !value.includes('@')
}
