// @vitest-environment node
import { expect, test } from 'vitest'
import {
  modelRequestTexts,
  modelToolOutputText,
} from '../e2e/desktop/modules/model-tool-output.mjs'
import { selectedToolCall } from '../e2e/desktop/modules/model-tool-calls.mjs'
import {
  programmaticSelection,
  discoverySelection,
} from '../e2e/desktop/modules/model-tool-catalog.mjs'
import {
  selectMcpTool,
  selectMcpToolRequest,
  requestToolSearchResults,
  toolOutputText,
} from '../e2e/desktop/modules/response-protocol.mjs'

const entry = { type: 'custom', name: 'exec' }
const variants = [
  { tools: [entry], input: [] },
  {
    input: [
      {
        type: 'additional_tools',
        tools: [{ type: 'namespace', name: 'functions', tools: [entry] }],
      },
    ],
  },
]
variants.push({
  tools: [
    {
      type: 'function',
      name: 'exec',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false,
      },
    },
  ],
  input: [],
})
const inputOf = event =>
  event.item.type === 'custom_tool_call' ? event.item.input : JSON.parse(event.item.arguments).input
const finalCall = events => events.find(event => event.type === 'response.output_item.done')

test.each(['function_call_output', 'custom_tool_call_output'])(
  'reads the bound Issue success marker from %s without confusing another call',
  type => {
    const marker = 'REMOTE_AGENT_DISPATCH_BOARD_READ_OK'
    const output = type === 'function_call_output' ? marker : [{ type: 'input_text', text: marker }]
    expect(
      toolOutputText(
        {
          input: [
            { type, call_id: 'other-call', output: 'Bound Issue read failed' },
            { type, call_id: 'bound-issue-read', output },
          ],
        },
        'bound-issue-read'
      )
    ).toBe(marker)
    expect(toolOutputText({ input: [] }, 'bound-issue-read')).toBeNull()
  }
)

const metadata = {
  name: 'mcp__wework_space__get_current_context',
  description:
    'Read current project.\n\nexec tool declaration:\nget_current_context(args: {}): Promise<unknown>',
}

test('policy recovery inspects native content blocks without treating them as object strings', () => {
  const policy = 'On a transient action error, inspect the existing page and retry that action once'
  const request = {
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'Current policy revision' }] },
      {
        type: 'custom_tool_call_output',
        call_id: 'runtime-policy-browser',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
          { type: 'input_text', text: 'Process exited with code 0' },
          { type: 'input_text', text: policy },
        ],
      },
    ],
  }
  expect(modelRequestTexts(request)).toContain(policy)
  expect(modelRequestTexts(request, 'developer')).toBe('Current policy revision')
  expect(modelRequestTexts(request)).not.toContain('[object Object]')
})
const run = async (input, catalog, tools) => {
  const output = []
  await new Function('ALL_TOOLS', 'tools', 'text', `return (async () => { ${input} })()`)(
    catalog,
    tools,
    value => output.push(value)
  )
  return output
}

for (const [index, request] of variants.entries()) {
  test(`native discovery and invocation preserve exec namespace (${index})`, async () => {
    const selection = discoverySelection(request, 'wework_space get_current_context')
    const event = finalCall(selectedToolCall('discover', selection))
    expect(event.item.namespace).toBe(index === 1 ? 'functions' : undefined)
    const [discovered] = await run(inputOf(event), [metadata], {})
    const history = {
      ...request,
      input: [
        ...request.input,
        {
          type: index === 2 ? 'function_call_output' : 'custom_tool_call_output',
          call_id: 'discover',
          output:
            index === 2
              ? 'Script completed\nWall time 0.0 seconds\nOutput:\n\n' + JSON.stringify(discovered)
              : [
                  {
                    type: 'input_text',
                    text: 'Script completed\nWall time 0.0 seconds\nOutput:\n',
                  },
                  { type: 'input_text', text: JSON.stringify(discovered) },
                ],
        },
      ],
    }
    expect(
      requestToolSearchResults(history).find(tool => tool.name === 'wework_space').tools[0]
        .codeModeName
    ).toBe(metadata.name)
    const tool = selectMcpTool(history, 'wework_space', 'get_current_context', {})
    const call = finalCall(selectedToolCall('invoke', tool))
    const result = await run(inputOf(call), [metadata], {
      [metadata.name]: async () => ({
        content: [{ type: 'text', text: '{"project":"real-result"}' }],
      }),
    })
    expect(result).toEqual(['{"project":"real-result"}'])
    expect(
      toolOutputText(
        {
          input: [
            {
              type: 'custom_tool_call_output',
              call_id: 'invoke',
              output: [
                { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
                { type: 'input_text', text: result[0] },
              ],
            },
          ],
        },
        'invoke'
      )
    ).toBe(result[0])
  })
}

test('native command polling cannot report completion before the process exits', async () => {
  const selected = programmaticSelection(variants[0], 'exec_command', { cmd: 'pwd' })
  expect(
    await run(
      inputOf(finalCall(selectedToolCall('poll-command', selected))),
      [{ name: 'exec_command' }],
      {
        exec_command: async () => ({ session_id: 42, output: 'partial' }),
      }
    )
  ).toEqual(['Process running with session ID 42', 'partial'])
  await expect(
    run(inputOf(finalCall(selectedToolCall('poll-command', selected))), [], {})
  ).rejects.toThrow('missing or ambiguous')
})

test('native discovery rejects empty and unbounded results', async () => {
  const selected = discoverySelection(variants[0], 'get_current_context')
  await expect(run(selected.codeMode.input, [], {})).rejects.toThrow('between one and eight')
  await expect(run(selected.codeMode.input, Array(9).fill(metadata), {})).rejects.toThrow(
    'between one and eight'
  )
})

test.each(['mcp__wework_space__get_current_context', 'wework_space__get_current_context'])(
  'qualified discovery selects the real identity %s despite description and suffix collisions',
  async name => {
    const target = { ...metadata, name }
    const catalog = [
      ...Array.from({ length: 12 }, (_, index) => ({
        name: `mcp__wework_space__unrelated_${index}`,
        description: metadata.description,
      })),
      { ...metadata, name: 'mcp__another_server__get_current_context' },
      target,
    ]
    const selected = selectMcpToolRequest(variants[0], 'get_current_context', {}, metadata.name)
    expect(selected.mode).toBe('search')
    expect(await run(selected.codeMode.input, catalog, {})).toEqual([{ tools: [target] }])
  }
)

test.each([
  ['missing', [{ ...metadata, name: 'mcp__another_server__get_current_context' }]],
  ['ambiguous', [metadata, { ...metadata, name: 'wework_space__get_current_context' }]],
])(
  'qualified discovery rejects a %s identity with actual catalog diagnostics',
  async (_, catalog) => {
    const selected = discoverySelection(
      variants[0],
      'wework_space get_current_context',
      metadata.name
    )
    await expect(run(selected.codeMode.input, catalog, {})).rejects.toThrow('one exact capability')
    await expect(run(selected.codeMode.input, catalog, {})).rejects.toThrow(
      JSON.stringify(catalog.map(tool => tool.name))
    )
  }
)

test('late permission options reach the real selected native command', async () => {
  const selection = programmaticSelection(variants[0], 'exec_command', { cmd: 'printf approved' })
  selection.arguments.sandbox_permissions = 'require_escalated'
  selection.arguments.justification = 'Write the explicitly approved regression proof'
  let captured
  await run(
    inputOf(finalCall(selectedToolCall('approved', selection))),
    [{ name: 'exec_command' }],
    {
      exec_command: async args => {
        captured = args
        return { exit_code: 0, output: 'approved' }
      },
    }
  )
  expect(captured).toEqual(selection.arguments)
  expect(captured.sandbox_permissions).toBe('require_escalated')
})

test('native running cells retain their wait handle while completed headers are removed', () => {
  const running = 'Script running with cell ID 7\nWall time 0.1 seconds\nOutput:\n'
  expect(modelToolOutputText([{ type: 'input_text', text: running }])).toBe(running)
  expect(
    modelToolOutputText('Script completed\nWall time 0.0 seconds\nOutput:\n\n{"ok":true}')
  ).toBe('{"ok":true}')
})

test('uses the latest native exec definition across incremental Lite catalog updates', () => {
  const batch = description => ({
    type: 'additional_tools',
    tools: [{ type: 'namespace', name: 'functions', tools: [{ ...entry, description }] }],
  })
  const request = { input: [batch('original'), batch('updated')] }
  expect(discoverySelection(request, 'get_current_context').codeMode.description).toBe('updated')
  expect(programmaticSelection(request, 'get_goal', {}).codeMode.description).toBe('updated')
  const top = {
    type: 'namespace',
    name: 'functions',
    tools: [{ ...entry, description: 'current' }],
  }
  expect(discoverySelection({ ...request, tools: [top] }, 'get_goal').codeMode.description).toBe(
    'current'
  )
  expect(discoverySelection({ ...request, tools: [entry] }, 'get_goal').codeMode).toEqual({
    ...entry,
    input: expect.any(String),
  })
})

test('selects the current API exec after a native Lite conversation changes provider', () => {
  const current = {
    type: 'function',
    name: 'exec',
    parameters: { properties: { input: { type: 'string' } } },
  }
  const input = variants[1].input
  const request = { input, tools: [current] }
  expect(discoverySelection(request, 'read_task').codeMode).toEqual({
    ...current,
    input: expect.any(String),
  })
  expect(programmaticSelection(request, 'get_goal', {}).codeMode).toEqual({
    ...current,
    targetName: 'get_goal',
  })
  expect(() => discoverySelection({ input, tools: [] }, 'read_task')).toThrow(
    'Expected exactly one native Code Mode discovery declaration'
  )
  expect(() =>
    discoverySelection({ input, tools: [current, ...variants[1].input[0].tools] }, 'read_task')
  ).toThrow('Expected exactly one native Code Mode discovery declaration')
})

test('keeps actual structured results and native permission-denial text', async () => {
  const selection = programmaticSelection(variants[0], 'model_only', {})
  const input = inputOf(finalCall(selectedToolCall('ordinary', selection)))
  const catalog = [{ name: 'mcp__counter__model_only' }]
  const result = {
    content: [{ type: 'text', text: 'Counter ready' }],
    structuredContent: { count: 0 },
  }
  expect(await run(input, catalog, { mcp__counter__model_only: async () => result })).toEqual([
    { count: 0 },
  ])
  const denied = 'Backend request failed (403 Forbidden): {"detail":"Insufficient permission"}'
  expect(
    await run(input, catalog, {
      mcp__counter__model_only: async () => ({
        isError: true,
        content: [{ type: 'text', text: denied }],
      }),
    })
  ).toEqual([denied])
})
