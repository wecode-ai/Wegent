import assert from 'node:assert/strict'
import { ACTIVE_COMPOSER_SELECTOR } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'

/** Assert native history reaches inference, not just the restored renderer. */
export function createUpgradeConversationContinuity(control, timeoutMs) {
  const completed = []
  let threadId
  let taskId
  return {
    observeModel(body) {
      const input = JSON.stringify(body.input ?? body.messages)
      for (const turn of completed) {
        assert.ok(input?.includes(turn.prompt), 'Upgrade lost a previous user input at inference')
        assert.ok(
          input?.includes(turn.answer),
          'Upgrade lost a previous assistant output at inference'
        )
      }
    },
    async send(prompt, answer) {
      const client = control()
      await client.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
      await client.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
      await client.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await client.command('waitFor', '[data-testid="message-assistant"]', {
        text: answer,
        timeoutMs,
      })
      completed.push({ prompt, answer })
    },
    async assertThread() {
      const client = control()
      const snapshot = JSON.parse(await client.command('getWorkbenchDebugSnapshot', 'body'))
      const address = snapshot.workbench?.currentRuntimeTask
      assert.ok(address?.taskId, 'Upgrade continuation requires the original runtime task')
      const { task } = await requestExecutor(client, 'runtime.tasks.get', { address }, timeoutMs)
      assert.ok(task.threadId, 'Upgrade continuation requires the original native thread')
      if (threadId) {
        assert.equal(
          task.threadId,
          threadId,
          'Upgrade must not replace or replay the native thread'
        )
        assert.equal(address.taskId, taskId, 'Upgrade must retain the task identity')
      } else {
        threadId = task.threadId
        taskId = address.taskId
      }
    },
    evidence() {
      assert.ok(threadId)
      return { sameNativeThread: true, verifiedTurns: completed.length }
    },
  }
}
