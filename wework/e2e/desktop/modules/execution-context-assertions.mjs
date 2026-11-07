import assert from 'node:assert/strict'
import { readRequestBody } from './response-protocol.mjs'

/** Inspect real Codex model input without adding a model call or application lifecycle. */
export function withExecutionContextAssertions(scenario, { marker, expected, workerContext }) {
  let observed = 0
  return {
    ...scenario,
    async handleHttp(request, response, url) {
      if (request.method === 'POST' && /\/responses$/.test(url.pathname)) {
        const body = await readRequestBody(request)
        const latest = (Array.isArray(body.input) ? body.input : [])
          .filter(item => item.role === 'user')
          .at(-1)
        const input = JSON.stringify(body.input ?? [])
        if (
          JSON.stringify(latest ?? '').includes(marker) &&
          (!workerContext || input.includes(workerContext))
        ) {
          for (const fact of expected)
            assert.ok(input.includes(fact), `Missing execution fact: ${fact}`)
          assert.ok(input.includes('native permissions'))
          observed++
        }
      }
      return scenario.handleHttp(request, response, url)
    },
    async verify(control) {
      await scenario.verify(control)
      assert.ok(observed > 0, 'The real worker must send execution context to Codex')
    },
  }
}
