import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-list-confirmation.scenario.mjs'

for (const [encoding, compress] of [
  ['identity', value => value],
  ['gzip', gzipSync],
  ['zstd', zstdCompressSync],
]) {
  test(`decodes real Codex ${encoding} model requests`, async () => {
    const payload = { model: 'gpt-5.5', input: [{ role: 'user', content: '配置重载验证' }] }
    const request = Readable.from([compress(Buffer.from(JSON.stringify(payload)))])
    request.headers = { 'content-encoding': encoding }
    const parsed = readRequestBody(request)
    assert.equal(readRequestBody(request), parsed, 'Repeated readers must share the body promise')
    assert.deepEqual(await parsed, payload)
  })
}

test('rejects malformed zstd instead of returning an empty request', async () => {
  const request = Readable.from([Buffer.from('invalid compressed request')])
  request.headers = { 'content-encoding': 'zstd' }
  await assert.rejects(readRequestBody(request))
})

test('keeps unsupported confirmation tools fatal and captures their complete schema and role', async () => {
  const tools = [
    {
      type: 'function',
      name: 'future_shell',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ]
  const additionalTools = [{ type: 'namespace', name: 'functions', tools }]
  const body = {
    model: 'diagnostic-model',
    tools,
    tool_choice: 'auto',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', thread_source: 'cli' }),
    },
    input: [
      { type: 'message', role: 'user', content: 'STAND_IN_VERIFY_EXPLICIT_WRITE_CONFIRMATION' },
      { type: 'additional_tools', tools: additionalTools },
    ],
  }
  const request = Readable.from([JSON.stringify(body)])
  request.method = 'POST'
  request.headers = { authorization: 'test-only-header' }
  const scenario = createDesktopScenario({ workspacePath: '/isolated-e2e-workspace' })

  await assert.rejects(
    scenario.handleHttp(request, {}, new URL('http://localhost/v1/responses')),
    /Real Codex did not advertise a supported shell tool/
  )

  const diagnostic = scenario.diagnostics().failedShellRequest
  assert.equal(diagnostic.requestKind, 'turn')
  assert.equal(diagnostic.threadSource, 'cli')
  assert.deepEqual(diagnostic.tools, tools)
  assert.deepEqual(diagnostic.input, [
    { type: 'message', role: 'user' },
    { type: 'additional_tools', role: null, tools: additionalTools },
  ])
  assert.ok(!JSON.stringify(diagnostic).includes('test-only-header'))
})
