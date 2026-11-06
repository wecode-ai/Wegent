// @vitest-environment node
import { expect, test } from 'vitest'
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
const metadata = {
  name: 'mcp__wework_space__get_current_context',
  description:
    'Read current project.\n\nexec tool declaration:\nget_current_context(args: {}): Promise<unknown>',
}
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
    const [event] = selectedToolCall('discover', selection)
    expect(event.item.namespace).toBe(index === 1 ? 'functions' : undefined)
    const [discovered] = await run(event.item.input, [metadata], {})
    const history = {
      ...request,
      input: [
        ...request.input,
        {
          type: 'custom_tool_call_output',
          call_id: 'discover',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
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
    const [call] = selectedToolCall('invoke', tool)
    const result = await run(call.item.input, [metadata], {
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
    await run(selected.codeMode.input, [{ name: 'exec_command' }], {
      exec_command: async () => ({ session_id: 42, output: 'partial' }),
    })
  ).toEqual(['Process running with session ID 42', 'partial'])
  await expect(run(selected.codeMode.input, [], {})).rejects.toThrow('missing or ambiguous')
})

test('native discovery rejects empty and unbounded results', async () => {
  const selected = discoverySelection(variants[0], 'get_current_context')
  await expect(run(selected.codeMode.input, [], {})).rejects.toThrow('between one and eight')
  await expect(run(selected.codeMode.input, Array(9).fill(metadata), {})).rejects.toThrow(
    'between one and eight'
  )
})
