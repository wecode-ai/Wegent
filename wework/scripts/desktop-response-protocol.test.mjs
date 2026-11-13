import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import { createMcpElicitationModel } from '../e2e/desktop/modules/mcp-elicitation-model.mjs'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'
import {
  MCP_ELICITATION_ACCEPTED_MARKER,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_PROMPT,
  MCP_ELICITATION_TOOL_NAME,
} from '../e2e/desktop/modules/shared.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-list-confirmation.scenario.mjs'
import { createDesktopScenario as createActionScenario } from '../e2e/desktop/scenarios/stand-in-action-confirmation.scenario.mjs'

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

test('waits for a yielded MCP elicitation cell and uses its cancellation result', () => {
  const model = createMcpElicitationModel()
  const tools = [
    {
      type: 'function',
      name: 'functions__exec',
      parameters: { type: 'object', properties: { input: { type: 'string' } } },
    },
    { type: 'function', name: 'functions__wait' },
  ]
  const output = (callId, value) => ({
    type: 'function_call_output',
    call_id: callId,
    output: value,
  })
  const request = input =>
    model({ tools, input }, 'response').find(event => event.type === 'response.output_item.done')
      .item
  const discovery = JSON.stringify({
    tools: [
      {
        name: `${MCP_ELICITATION_NAMESPACE}__${MCP_ELICITATION_TOOL_NAME}`,
        description: 'exec tool declaration:',
      },
    ],
  })
  const markers = [
    MCP_ELICITATION_ACCEPTED_MARKER,
    MCP_ELICITATION_ACCEPTED_MARKER,
    'E2E_MCP_ELICITATION_TIMEOUT:url_timeout:cancel',
    'E2E_MCP_ELICITATION_TIMEOUT:form_timeout:cancel',
  ]

  for (const [index, marker] of markers.entries()) {
    const search = request([{ type: 'message', role: 'user', content: MCP_ELICITATION_PROMPT }])
    const call = request([output(search.call_id, discovery)])
    let result = output(call.call_id, marker)
    if (index === 3) {
      const pending = output(
        call.call_id,
        'Script running with cell ID 4\nWall time 31.0 seconds\nOutput:\n'
      )
      const wait = request([pending])
      assert.equal(wait.name, 'functions__wait')
      assert.deepEqual(JSON.parse(wait.arguments), { cell_id: '4', yield_time_ms: 30_000 })
      assert.throws(() => request([pending, output(wait.call_id, 'unexpected')]), /did not return/)
      result = output(wait.call_id, [{ type: 'input_text', text: marker }])
    }
    assert.equal(
      request([result]).content[0].text,
      `${MCP_ELICITATION_COMPLETION_TEXT}:${index + 1}`
    )
  }
})

for (const [surface, createScenario] of [
  ['list', createDesktopScenario],
  ['action', createActionScenario],
]) {
  for (const mode of ['direct', 'code_mode']) {
    test(`preserves explicit file-write approval in ${surface} ${mode} confirmation responses`, async () => {
      const workspacePath = '/isolated-e2e-workspace'
      const body = {
        input: [
          { type: 'message', role: 'user', content: 'STAND_IN_VERIFY_EXPLICIT_WRITE_CONFIRMATION' },
        ],
      }
      if (mode === 'code_mode') {
        body.input.push({
          type: 'additional_tools',
          tools: [
            { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] },
          ],
        })
      } else {
        body.tools = [{ type: 'function', name: 'exec_command' }]
      }
      const request = Readable.from([JSON.stringify(body)])
      request.method = 'POST'
      request.headers = {}
      let output
      const response = {
        writeHead(status) {
          assert.equal(status, 200)
        },
        end(value) {
          output = value
        },
      }
      const scenario = createScenario({ workspacePath })
      assert.equal(
        await scenario.handleHttp(request, response, new URL('http://localhost/v1/responses')),
        true
      )
      const events = output
        .split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(6)))
      const call = events.find(
        event =>
          event.type === 'response.output_item.done' &&
          event.item?.call_id === 'stand-in-file-write'
      ).item
      let command
      if (mode === 'code_mode') {
        assert.equal(call.type, 'custom_tool_call')
        assert.equal(call.namespace, 'functions')
        assert.equal(call.name, 'exec')
        await runInNewContext(`(async () => { ${call.input} })()`, {
          text() {},
          tools: {
            exec_command: async value => {
              command = value
              return { exit_code: 0, output: '' }
            },
          },
        })
      } else {
        assert.equal(call.type, 'function_call')
        assert.equal(call.name, 'exec_command')
        command = JSON.parse(call.arguments)
      }
      assert.equal(command.cmd, `touch '${workspacePath}/stand-in-approved.txt'`)
      assert.equal(command.workdir, workspacePath)
      assert.equal(command.sandbox_permissions, 'require_escalated')
      assert.equal(command.justification, '确认后创建隔离测试工作区中的验证文件。')
      assert.equal(scenario.diagnostics().failedShellRequest, null)
    })
  }
}

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
