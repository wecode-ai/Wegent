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
