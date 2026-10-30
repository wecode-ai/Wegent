import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { createDesktopScenario } from '../e2e/desktop/scenarios/startup-network-change.scenario.mjs'

const recovered =
  '[startup-network-fault] injected\nnet::ERR_NETWORK_CHANGED\n[startup-network-recovery]\n'
const ready = "[startup] { step: 'renderer-startup-ready', status: 'completed' }\n"

test('waits for host readiness recorded after the new-chat button appears', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-startup-log-'))
  onTestFinished(() => rm(resultDir, { recursive: true, force: true }))
  const logPath = join(resultDir, 'app.log')
  await writeFile(logPath, recovered)
  const scenario = await createDesktopScenario({ resultDir, workbenchReadyTimeoutMs: 1000 })
  const buttonObserved = Promise.withResolvers()
  const commands = []
  let finished = false
  const verifying = scenario
    .verify({
      async command(command, selector) {
        commands.push([command, selector])
        if (command === 'waitFor' && selector.includes('new-chat-button')) buttonObserved.resolve()
        if (command === 'click') assert.ok((await readFile(logPath, 'utf8')).includes(ready))
      },
    })
    .then(
      () => {
        finished = true
        return null
      },
      error => {
        finished = true
        return error
      }
    )
  await buttonObserved.promise
  await delay(25)
  assert.equal(finished, false, 'The visible button must not substitute for host readiness')
  await appendFile(logPath, ready)
  assert.equal(await verifying, null)
  assert.deepEqual(commands, [
    ['waitFor', '[data-testid="new-chat-button"]'],
    ['click', '[data-testid="new-chat-button"]'],
    ['waitFor', '[data-testid="chat-message-input"]'],
  ])
})

test('still rejects readiness recorded before the network recovery', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-startup-order-'))
  onTestFinished(() => rm(resultDir, { recursive: true, force: true }))
  await writeFile(join(resultDir, 'app.log'), ready + recovered)
  const scenario = await createDesktopScenario({ resultDir, workbenchReadyTimeoutMs: 1000 })
  await assert.rejects(scenario.verify({ command: async () => {} }), assert.AssertionError)
})
