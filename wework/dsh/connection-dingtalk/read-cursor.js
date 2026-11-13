import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TTL_MS = 30 * 60 * 1000
const MAX_LENGTH = 8192

export function createReadCursor(now = Date.now) {
  const key = randomBytes(32)
  const binding = source =>
    JSON.stringify(
      ['providerId', 'profile', 'kind', 'id', 'transport', 'enabledAfter'].map(
        field => source[field] ?? null
      )
    )
  const sign = value => createHmac('sha256', key).update(value).digest()
  return {
    encode(source, state) {
      const payload = Buffer.from(JSON.stringify({ ...state, binding: binding(source) })).toString(
        'base64url'
      )
      const token = `${payload}.${sign(payload).toString('base64url')}`
      if (token.length > MAX_LENGTH) throw invalid()
      return token
    },
    decode(source, input) {
      try {
        const token = input.cursor
        if (typeof token !== 'string' || token.length > MAX_LENGTH) throw invalid()
        const parts = token.split('.')
        if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)))
          throw invalid()
        const signature = Buffer.from(parts[1], 'base64url')
        const expected = sign(parts[0])
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
          throw invalid()
        const state = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
        if (
          state.binding !== binding(source) ||
          !Number.isSafeInteger(state.issuedAt) ||
          state.issuedAt > now() ||
          now() - state.issuedAt > TTL_MS ||
          !Number.isFinite(Date.parse(state.start)) ||
          !Number.isFinite(Date.parse(state.end)) ||
          !Number.isFinite(Date.parse(state.time)) ||
          !Number.isSafeInteger(state.limit) ||
          state.limit < 1 ||
          state.limit > 20 ||
          (input.since !== undefined && Date.parse(input.since) !== Date.parse(state.start)) ||
          (input.limit !== undefined && input.limit !== state.limit) ||
          (input.includeImages !== undefined && input.includeImages !== state.includeImages)
        )
          throw invalid()
        return state
      } catch {
        throw invalid()
      }
    },
  }
}

function invalid() {
  return Object.assign(
    new Error(
      'The read cursor is invalid, expired or belongs to another connection; restart the read'
    ),
    { code: 'source_read_cursor_invalid' }
  )
}
