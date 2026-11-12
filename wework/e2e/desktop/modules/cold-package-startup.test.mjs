import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseStartupEvents,
  splitStartupAttempts,
  summarizeStartupAttempt,
  waitForStartupAttempt,
} from './cold-package-startup.mjs'

const log = `
[startup] { step: 'device-id-resolve', status: 'started', elapsedMs: 1 }
[startup] { step: 'desktop-components-prepare', status: 'started', elapsedMs: 400 }
[startup] { step: 'component-weworkCorePlugins-verify', status: 'completed', elapsedMs: 5000, phaseElapsedMs: 4550 }
[startup] { step: 'desktop-components-prepare', status: 'completed', elapsedMs: 5100 }
[startup] { step: 'core-dsh-profile-reuse', status: 'completed', elapsedMs: 5200, phaseElapsedMs: 2 }
[startup] { step: 'main-window-show', status: 'completed', elapsedMs: 12000 }
[startup] { step: 'device-id-resolve', status: 'started', elapsedMs: 1 }
[startup] { step: 'core-dsh-profile-rebuild', status: 'completed', elapsedMs: 8000, phaseElapsedMs: 3400 }
[startup] { step: 'main-window-show', status: 'completed', elapsedMs: 14000 }
`

test('splits restarts and summarizes lifecycle and nested stage durations', async () => {
  const attempts = splitStartupAttempts(parseStartupEvents(log))
  assert.equal(attempts.length, 2)
  assert.deepEqual(summarizeStartupAttempt(attempts[0]), {
    mainWindowShowElapsedMs: 12000,
    phaseDurationsMs: {
      'component-weworkCorePlugins-verify': 4550,
      'core-dsh-profile-reuse': 2,
      'desktop-components-prepare': 4700,
    },
    events: attempts[0],
  })

  const restarted = await waitForStartupAttempt('/unused/app.log', 2, {
    timeoutMs: 1000,
    readLog: async () => log,
  })
  assert.equal(restarted.mainWindowShowElapsedMs, 14000)
  assert.equal(restarted.phaseDurationsMs['core-dsh-profile-rebuild'], 3400)
})
