import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopScenario } from '../e2e/desktop/scenarios/system-proxy.scenario.mjs'
import { REPLY_PREDICTION_PROMPT } from '../e2e/desktop/modules/response-protocol.mjs'

test('proxy model fixture honors the shared prediction protocol and ordinary completion', async () => {
  const scenario = await createDesktopScenario({ pac: true })
  try {
    for (const [input, expected] of [
      [REPLY_PREDICTION_PROMPT, '{"suggestion":null}'],
      ['WEWORK_DESKTOP_E2E_SYSTEM_PROXY', 'WEWORK_DESKTOP_E2E_SYSTEM_PROXY_COMPLETE'],
    ]) {
      const response = await fetch(`${scenario.modelServerUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: [{ role: 'user', content: input }] }),
      })
      assert.equal(response.status, 200)
      const events = (await response.text())
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
      const message = events.find(event => event.type === 'response.output_item.done')
      assert.equal(message.item.content[0].text, expected)
      assert.ok(events.some(event => event.type === 'response.completed'))
    }
  } finally {
    await scenario.cleanup()
  }
})
