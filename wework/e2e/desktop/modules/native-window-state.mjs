import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function waitForClosedStartupSplash(control, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let snapshot

  do {
    snapshot = JSON.parse(await control.command('getStartupSplashSnapshot', 'body'))
    if (snapshot.state === 'closed') return snapshot
    await delay(50)
  } while (Date.now() < deadline)

  assert.fail(
    `The Electron startup splash did not close within ${timeoutMs}ms: ${JSON.stringify(snapshot)}`
  )
}

export async function waitForWindowState(control, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = JSON.parse(await control.command('getNativeWindowState', 'body'))
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}
