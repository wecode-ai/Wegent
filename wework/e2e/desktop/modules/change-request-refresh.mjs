import assert from 'node:assert/strict'
import { waitForLogPattern } from './shared.mjs'

/** Await the native refresh before applying the separate UI presentation budget. */
export async function waitForChangeRequestRefresh(logPath, { fromOffset, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  const startedPattern =
    /app IPC request started request_id=(\S+) method=device\.execute_command command_key=connection_observer_refresh\b/
  const startedLog = await waitForLogPattern(logPath, startedPattern, {
    fromOffset,
    timeoutMs,
  })
  const requestId = startedPattern.exec(startedLog.slice(fromOffset))[1]
  const escapedId = requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const finishedPattern = new RegExp(
    `app IPC request finished request_id=${escapedId} method=device\\.execute_command command_key=connection_observer_refresh\\b[^\\n]*\\bok=(true|false)\\b`
  )
  const finishedLog = await waitForLogPattern(logPath, finishedPattern, {
    fromOffset,
    timeoutMs: deadline - Date.now(),
  })
  assert.equal(
    finishedPattern.exec(finishedLog.slice(fromOffset))[1],
    'true',
    `The native pull request refresh failed (${requestId})`
  )
}
