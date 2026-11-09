// @vitest-environment node
import { describe, expect, test } from 'vitest'
import {
  MATRIX_PROVIDER_INSTRUCTIONS,
  MATRIX_LEGACY_INSTRUCTIONS,
} from '../e2e/desktop/modules/model-native-catalog.mjs'
import {
  assertProgressiveHi,
  assertRequiredToolInventory,
  MATRIX_REQUIRED_TOOLS,
  INITIAL_CONTEXT_TOKEN_LIMIT,
  MATRIX_UNUSED_SKILL_CANARY,
  countModelRequest,
  MATRIX_MCP_DESCRIPTION,
  MATRIX_SKILL_CANARY,
} from '../e2e/desktop/modules/model-progressive-contract.mjs'
import {
  assertCodeModeOutput,
  assertCodeModeRequest,
} from '../e2e/desktop/modules/model-wire-contract.mjs'

const baseInstructions = 'You are Codex, an agent based on GPT-6.'
const script = 'text(await tools.apply_patch("line 1\\n中文\\nline 3"))'
const result = { callId: 'native-call', script, marker: 'REAL_EXEC_RESULT' }
const budget = { encoding: 'o200k_base', tokens: 500, bytes: 1200 }
const exec = { type: 'custom', name: 'exec', description: 'Native code execution entrypoint' }
const wrapper = {
  name: 'exec',
  parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
}

function request(protocol, instructions = baseInstructions) {
  if (protocol === 'chat')
    return {
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: wrapper }],
    }
  if (protocol === 'anthropic')
    return {
      system: instructions,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ ...wrapper, input_schema: wrapper.parameters }],
    }
  return {
    instructions,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ ...exec }],
  }
}

function output(protocol, callId = result.callId, input = script) {
  const body = request(protocol)
  if (protocol === 'responses')
    body.input.push(
      { type: 'custom_tool_call', call_id: callId, name: 'exec', input },
      { type: 'custom_tool_call_output', call_id: callId, output: result.marker }
    )
  else if (protocol === 'chat')
    body.messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: callId, function: { name: 'exec', arguments: JSON.stringify({ input }) } },
        ],
      },
      { role: 'tool', tool_call_id: callId, content: result.marker }
    )
  else
    body.messages.push(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'exec', input: { input } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content: result.marker }],
      }
    )
  return body
}

for (const protocol of ['responses', 'chat', 'anthropic']) {
  describe(`${protocol} model-side acceptance oracle`, () => {
    test('preserves the upstream canonical template instead of requiring a Wework replacement', () => {
      const body = request(protocol, MATRIX_PROVIDER_INSTRUCTIONS)
      expect(() => assertProgressiveHi(body, { protocol, source: 'codex' }, budget)).not.toThrow()
      const legacy = request(protocol, MATRIX_LEGACY_INSTRUCTIONS)
      expect(() => assertProgressiveHi(legacy, { protocol, source: 'codex' }, budget)).toThrow(
        'canonical'
      )
      const duplicate = request(
        protocol,
        MATRIX_PROVIDER_INSTRUCTIONS + '\n' + MATRIX_PROVIDER_INSTRUCTIONS
      )
      expect(() => assertProgressiveHi(duplicate, { protocol, source: 'codex' }, budget)).toThrow(
        'exactly once'
      )
    })

    test('accepts the bootstrap without expanding undiscovered tools', () => {
      const body = request(protocol)
      expect(assertProgressiveHi(body, { protocol }, budget)).toEqual(budget)
      expect(assertCodeModeRequest(body, { protocol, lite: false }).name).toBe('exec')
    })
    for (const marker of [
      MATRIX_MCP_DESCRIPTION,
      MATRIX_SKILL_CANARY,
      MATRIX_UNUSED_SKILL_CANARY,
      '### `get_goal`',
    ]) {
      test(`rejects a body leaked inside a converted description: ${marker}`, () => {
        const body = request(protocol)
        body.tools[0].description = `Original tool definition: ${JSON.stringify({ description: marker })}`
        expect(() => assertProgressiveHi(body, { protocol }, budget)).toThrow('leaked')
      })
    }
    test('checks the exact script and its correlated execution result', () => {
      expect(() => assertCodeModeOutput(output(protocol), protocol, result)).not.toThrow()
      expect(() => assertCodeModeOutput(output(protocol, 'other-call'), protocol, result)).toThrow()
      expect(() =>
        assertCodeModeOutput(output(protocol, result.callId, script + ' altered'), protocol, result)
      ).toThrow()
    })
    test('rejects a marker echoed in a user message without native output', () => {
      const body = request(protocol)
      const messages = body.input ?? body.messages
      messages.push({ role: 'user', content: result.marker })
      expect(() => assertCodeModeOutput(body, protocol, result)).toThrow()
    })
  })
}

test('Lite input declarations are checked even when top-level tools is absent', () => {
  const body = {
    input: [
      {
        type: 'additional_tools',
        tools: [{ type: 'namespace', name: 'functions', tools: [exec] }],
      },
    ],
  }
  expect(assertCodeModeRequest(body, { protocol: 'responses', lite: true }).name).toBe('exec')
  body.input.push({ role: 'user', content: 'hi' })
  body.input[0].tools[0].tools.push({ type: 'function', name: 'get_goal', parameters: {} })
  expect(() => assertProgressiveHi(body, { protocol: 'responses' }, budget)).toThrow(
    'undiscovered tool'
  )
})

test('the native context budget rejects its exact threshold', () => {
  expect(() =>
    assertProgressiveHi(
      request('responses'),
      { protocol: 'responses' },
      { ...budget, tokens: INITIAL_CONTEXT_TOKEN_LIMIT }
    )
  ).toThrow(`must be < ${INITIAL_CONTEXT_TOKEN_LIMIT}`)
})

test('the pinned tokenizer includes declarations in input and every other request field', () => {
  const body = request('responses')
  const small = countModelRequest(body)
  body.input.unshift({
    type: 'additional_tools',
    tools: [{ ...exec, description: 'schema token '.repeat(8000) }],
  })
  const large = countModelRequest(body)
  expect(small.encoding).toBe('o200k_base')
  expect(small.tokens).toBeLessThan(INITIAL_CONTEXT_TOKEN_LIMIT)
  expect(large.tokens).toBeGreaterThan(INITIAL_CONTEXT_TOKEN_LIMIT)
  expect(() => assertProgressiveHi(body, { protocol: 'responses' }, large)).toThrow(
    `must be < ${INITIAL_CONTEXT_TOKEN_LIMIT}`
  )
}, 30_000)

const requiredInventory = [
  ...MATRIX_REQUIRED_TOOLS.map(name => ({
    name,
    description: 'declare const tools: { ' + name + '() }',
  })),
  { name: 'mcp__github__issues__get_issue_details', description: MATRIX_MCP_DESCRIPTION },
]

test('required capabilities cannot disappear, duplicate or expand unrelated capabilities during discovery', () => {
  const result = tools => 'Script completed\nOutput:\n' + JSON.stringify(tools, null, 2)
  expect(assertRequiredToolInventory(result(requiredInventory))).toEqual(requiredInventory)
  for (const removed of requiredInventory) {
    expect(() =>
      assertRequiredToolInventory(result(requiredInventory.filter(tool => tool !== removed)))
    ).toThrow()
  }
  expect(() =>
    assertRequiredToolInventory(result([...requiredInventory, requiredInventory[0]]))
  ).toThrow()
  expect(() =>
    assertRequiredToolInventory(
      result([...requiredInventory, { name: 'unrelated', description: 'Unrequested capability' }])
    )
  ).toThrow()
  const missingSignature = requiredInventory.map(tool =>
    tool.name === 'get_goal' ? { ...tool, description: 'Schema missing' } : tool
  )
  expect(() => assertRequiredToolInventory(result(missingSignature))).toThrow('signature')
})

test('first-request checks reject arbitrary expanded tools and nested exec declarations', () => {
  const body = request('responses')
  body.tools.push({ type: 'function', name: 'unexpected_future_tool', parameters: {} })
  expect(() => assertProgressiveHi(body, { protocol: 'responses' }, budget)).toThrow(
    'undiscovered tool schema'
  )
  body.tools.pop()
  body.tools[0].description += '\n### `future_nested_tool`\nFull signature'
  expect(() => assertProgressiveHi(body, { protocol: 'responses' }, budget)).toThrow(
    'expanded nested tool'
  )
})

describe('matrix failure aggregation', () => {
  test('retains failures across cases and rejects the final aggregate', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { recordMatrixFailure, writeMatrixReport, assertMatrixReports } =
      await import('../e2e/desktop/modules/model-matrix-audit.mjs')
    const directory = mkdtempSync(join(tmpdir(), 'model-matrix-report-'))
    const control = { matrixEvidenceDirectory: directory }
    try {
      const model = { execution: 'local', source: 'local', protocol: 'responses' }
      control.matrixState = { stage: 'complete', requests: [{}], failures: [] }
      recordMatrixFailure(control, 'hi', new Error('budget exceeded'))
      writeMatrixReport(control, model)
      control.matrixState = { stage: 'complete', requests: [{}], failures: [] }
      writeMatrixReport(control, { ...model, protocol: 'chat' })
      const reports = JSON.parse(readFileSync(join(directory, 'model-matrix-results.json')))
      expect(reports).toHaveLength(2)
      expect(reports.map(report => report.passed)).toEqual([false, true])
      expect(() => assertMatrixReports(control)).toThrow('1/2 model matrix cases failed')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('native discovery protocol adapters', () => {
  for (const protocol of ['responses', 'chat', 'anthropic']) {
    test(`advertises and invokes the real ${protocol} search declaration`, async () => {
      const { handleDirectMatrixAudit } =
        await import('../e2e/desktop/modules/model-matrix-audit.mjs')
      const tool = {
        name: 'search_deferred_tools',
        description: 'Search',
        parameters: { type: 'object' },
      }
      const tools =
        protocol === 'anthropic'
          ? [{ name: tool.name, description: tool.description, input_schema: tool.parameters }]
          : protocol === 'chat'
            ? [{ type: 'function', function: tool }]
            : [{ ...tool, type: 'function' }]
      const calls = []
      const control = {
        matrixState: {},
        writeSse: (...args) => calls.push(args),
        writeChatToolCall: (...args) => calls.push(args),
        writeAnthropicToolCall: (...args) => calls.push(args),
      }
      expect(handleDirectMatrixAudit(control, {}, { protocol }, { tools })).toBe(true)
      expect(calls).toHaveLength(1)
      expect(control.matrixState.directAuditStage).toBe('search')
      expect(control.matrixState.deferAudit.mcpDiscovery).toBe('pending')
    })
  }
})

describe('Responses discovery result declarations', () => {
  for (const native of [true, false]) {
    test(`invokes the ${native ? 'native namespace' : 'standard flattened'} declaration after search`, async () => {
      const { handleDirectMatrixAudit } =
        await import('../e2e/desktop/modules/model-matrix-audit.mjs')
      const member = {
        type: 'function',
        name: 'get_issue_details',
        description: MATRIX_MCP_DESCRIPTION,
      }
      const batch = [{ type: 'namespace', name: 'github__issues', tools: [member] }]
      const body = {
        tools: native ? [] : [{ ...member, name: 'github__issues__get_issue_details' }],
        input: [
          native
            ? { type: 'tool_search_output', call_id: 'matrix-native-search', tools: batch }
            : {
                type: 'function_call_output',
                call_id: 'matrix-native-search',
                output: JSON.stringify({ tools: batch }),
              },
        ],
      }
      let events
      const control = {
        matrixState: { directAuditStage: 'search', deferAudit: {} },
        writeSse: (_response, items) => {
          events = items
        },
      }
      expect(handleDirectMatrixAudit(control, {}, { protocol: 'responses' }, body)).toBe(true)
      const call = events.find(event => event.item?.type === 'function_call').item
      expect(call.name).toBe(native ? 'get_issue_details' : 'github__issues__get_issue_details')
      expect(call.namespace).toBe(native ? 'github__issues' : undefined)
      expect(control.matrixState.deferAudit.mcpDiscovery).toBe('passed')
      expect(control.matrixState.directAuditStage).toBe('mcp')
    })
  }
})

test('rejects an empty matrix run', async () => {
  const { assertMatrixReports } = await import('../e2e/desktop/modules/model-matrix-audit.mjs')
  expect(() => assertMatrixReports({})).toThrow('No model matrix cases executed')
})

test('protocol switching preserves enabled plugins, MCP and unrelated settings', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { setMatrixUpstreamProtocol } =
    await import('../e2e/desktop/modules/desktop-build-flows.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'matrix-config-'))
  const config =
    'model = "fixture"\n[model_providers.fixture]\nupstream_api_format = "openai-responses"\n[plugins.runtime]\nenabled = true\n[mcp_servers.fixture]\ncommand = "node"\n'
  try {
    const path = join(directory, 'config.toml')
    await writeFile(path, config)
    for (const [protocol, format] of [
      ['chat', 'openai-chat-completions'],
      ['anthropic', 'anthropic-messages'],
      ['responses', 'openai-responses'],
    ]) {
      await setMatrixUpstreamProtocol(directory, protocol)
      expect(await readFile(path, 'utf8')).toBe(
        config.replace(
          'upstream_api_format = "openai-responses"',
          `upstream_api_format = "${format}"`
        )
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reads enabled skill catalog names across protocol wrappers', async () => {
  const { matrixSkillNames } = await import('../e2e/desktop/modules/model-matrix-audit.mjs')
  const catalog =
    '- model-matrix: Fixture. (file: r0/SKILL.md)\n- plugin:skill: Other fixture. (file: r1/SKILL.md)'
  for (const body of [{ system: catalog }, { input: [{ content: [{ text: catalog }] }] }])
    expect(matrixSkillNames(body)).toEqual(['model-matrix', 'plugin:skill'])
})

test('the Anthropic default hi may share a user message with native environment context', () => {
  const body = request('anthropic')
  body.messages[0].content = [
    { type: 'text', text: '<environment_context>native</environment_context>' },
    { type: 'text', text: 'hi' },
  ]
  expect(assertProgressiveHi(body, { protocol: 'anthropic' }, budget)).toEqual(budget)
  body.messages[0].content.at(-1).text = 'generate a title'
  expect(() => assertProgressiveHi(body, { protocol: 'anthropic' }, budget)).toThrow(
    'real default hi'
  )
})

test('a native hosted search descriptor does not admit expanded function schemas', () => {
  const body = request('responses')
  body.tools.push({ type: 'web_search' })
  expect(assertProgressiveHi(body, { protocol: 'responses' }, budget)).toEqual(budget)
  body.tools[1] = { type: 'function', name: 'web_search', parameters: { type: 'object' } }
  expect(() => assertProgressiveHi(body, { protocol: 'responses' }, budget)).toThrow(
    'undiscovered tool schema'
  )
})
