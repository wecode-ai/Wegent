import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/local-artifact-declaration.scenario.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createSingleRootLocalProject: vi.fn(),
  selectE2EModel: vi.fn(),
}))

test('retains bounded artifact parser evidence without accepting malformed metadata', async () => {
  const scenario = createDesktopScenario({ workspacePath: '/fixture', uiTimeoutMs: 100 })
  const stopBeforeUi = new Error('Stop before desktop UI setup')
  await expect(
    scenario.verify({
      command: async () => {
        throw stopBeforeUi
      },
    })
  ).rejects.toBe(stopBeforeUi)
  const decoded =
    JSON.stringify({ name: 'local report.md', detail: 'x'.repeat(500) }) + 'unexpected'
  const encoded = Buffer.from(decoded).toString('base64')
  const request = Readable.from([
    JSON.stringify({
      input: [
        { role: 'user', content: 'WEWORK_LOCAL_ARTIFACT_DECLARATION' },
        {
          type: 'function_call_output',
          call_id: 'local-artifact-generate',
          output: `LOCAL_ARTIFACT_RESULT:${encoded}\n`,
        },
      ],
    }),
  ])
  request.method = 'POST'
  await expect(
    scenario.handleHttp(request, {}, new URL('http://fixture/v1/responses'))
  ).rejects.toThrow(SyntaxError)
  expect(scenario.diagnostics()).toMatchObject({
    declaration: {
      encodedLength: encoded.length,
      decodedBytes: Buffer.byteLength(decoded),
      encodedTail: encoded.slice(-128),
      decodedTail: decoded.slice(-160),
    },
  })
  expect(scenario.diagnostics().declaration.encodedTail.length).toBeLessThanOrEqual(128)
  expect(scenario.diagnostics().declaration.decodedTail.length).toBeLessThanOrEqual(160)
})
