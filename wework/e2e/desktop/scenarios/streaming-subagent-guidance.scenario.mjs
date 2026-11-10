import assert from 'node:assert/strict'
import { createDesktopScenario as createStreamingScenario } from './streaming-text.scenario.mjs'
import { ACTIVE_WORKBENCH_SELECTOR, COMPOSER_SELECTOR } from '../modules/streaming-text-fixture.mjs'

const GUIDANCE = 'Continue the parent investigation while the child finishes.'

/** Reuse the real subagent lifecycle, steering only while its final stream is held. */
export function createDesktopScenario(options) {
  let releaseChildText
  const subagentTextRelease = new Promise(resolve => {
    releaseChildText = resolve
  })
  const scenario = createStreamingScenario({
    ...options,
    checkpoint: 'streaming-subagents',
    subagentTextRelease,
    async beforeSubagentOutput(control) {
      await control.command('fill', COMPOSER_SELECTOR, { value: GUIDANCE })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', '[data-testid="user-message-content"]', {
        text: GUIDANCE,
      })
      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const messages = JSON.parse(
        await control.command('getRuntimeConversationMessages', 'body', {
          value: JSON.stringify(debug.workbench.currentRuntimeTask),
        })
      )
      const guidance = messages.findIndex(
        message => message.role === 'user' && message.content.includes(GUIDANCE)
      )
      assert.ok(
        guidance >= 0 && messages[guidance].runtimeGuidance,
        'The message must steer the active native turn'
      )
      assert.ok(
        messages
          .slice(0, guidance)
          .some(message => message.blocks?.some(block => block.type === 'subagent')),
        'The subagent card must precede the guidance boundary'
      )
      releaseChildText()
    },
  })
  return {
    ...scenario,
    cleanup() {
      releaseChildText()
      scenario.cleanup()
    },
  }
}
