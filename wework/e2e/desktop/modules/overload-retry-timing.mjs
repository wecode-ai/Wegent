import assert from 'node:assert/strict'

export const OVERLOAD_FIRST_RETRY_DELAY_MS = Number(
  process.env.WEWORK_E2E_OVERLOAD_RETRY_BASE_MS ?? 10_000
)

if (
  !Number.isSafeInteger(OVERLOAD_FIRST_RETRY_DELAY_MS) ||
  OVERLOAD_FIRST_RETRY_DELAY_MS < 1 ||
  OVERLOAD_FIRST_RETRY_DELAY_MS > 10_000
) {
  throw new Error('WEWORK_E2E_OVERLOAD_RETRY_BASE_MS must be an integer between 1 and 10000')
}

export function assertOverloadRetryTiming(log) {
  assert.match(
    log,
    new RegExp(
      'codex overloaded turn recovery[^\\n]*\\bretry=1\\b[^\\n]*\\bdelay_ms=' +
        OVERLOAD_FIRST_RETRY_DELAY_MS +
        '\\b'
    ),
    'The real Executor must use the configured first retry delay before observing cancellation'
  )
}
