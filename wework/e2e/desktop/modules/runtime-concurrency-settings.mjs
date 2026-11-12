import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

// Extends the CI-covered runtime-task-queue checkpoint with real UI/Runtime persistence.
export async function verifyIndependentConcurrencySettings(control, timeoutMs, captureScreenshot) {
  const personal = '[data-testid="general-max-concurrent-tasks-select"]'
  const standIn = '[data-testid="general-max-concurrent-stand-in-tasks-select"]'
  const agent = '[data-testid="general-max-concurrent-agent-tasks-select"]'
  const read = () => requestExecutor(control, 'runtime.settings.get', {}, timeoutMs)
  const original = await read()
  const setLimit = async (selector, value) => {
    await control.command('waitFor', `${selector}:enabled`, { timeoutMs })
    await control.command('select', selector, { value: String(value) })
    await control.command('waitFor', `${selector}:enabled`, { timeoutMs })
  }
  try {
    await setLimit(standIn, 3)
    await setLimit(agent, 4)
    assert.deepEqual(await read(), {
      maxConcurrentTasks: 1,
      maxConcurrentStandInTasks: 3,
      maxConcurrentAgentTasks: 4,
    })
    await control.command('click', '[data-testid="settings-back-button"]')
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    for (const [selector, value] of [
      [personal, '1'],
      [standIn, '3'],
      [agent, '4'],
    ]) {
      await control.command('waitFor', `${selector}:enabled`, { timeoutMs })
      assert.equal(await control.command('getValue', selector), value)
    }
    const capacity = await requestExecutor(control, 'runtime.capacity.get', {}, timeoutMs)
    assert.equal(capacity.categories.personal.limit, 1)
    assert.equal(capacity.categories.standIn.limit, 3)
    assert.equal(capacity.categories.agent.limit, 4)
    await control.command('scrollIntoView', '[data-testid="general-settings-runtime-section"]')
    await captureScreenshot(control, 'runtime-concurrency-settings-three-owners.png', 'body')
  } finally {
    await setLimit(standIn, original.maxConcurrentStandInTasks)
    await setLimit(agent, original.maxConcurrentAgentTasks)
    assert.deepEqual(await read(), original)
  }
}
