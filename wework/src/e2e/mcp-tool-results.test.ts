// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { readMcpToolOutput } from '../../e2e/desktop/modules/mcp-tool-results.mjs'

const callId = 'native-mcp-call'
const header = 'Wall time: 0.0042 seconds\nOutput:'
const request = (output: unknown) => ({
  input: [{ type: 'function_call_output', call_id: callId, output }],
})

describe('native MCP result text', () => {
  test('reads the timed text projection of a real Codex MCP result', () => {
    const result = { bound: false, description: 'Wall time: is part of the Issue text' }
    const output = `${header}\n${JSON.stringify(result)}`
    expect(JSON.parse(readMcpToolOutput(request(output), callId))).toEqual(result)
  })

  test('keeps a JSON array result as application data', () => {
    const result = [{ id: 'space-1', name: 'Project space' }]
    expect(
      JSON.parse(readMcpToolOutput(request(`${header}\n${JSON.stringify(result)}`), callId))
    ).toEqual(result)
  })

  test('reads text from native multimodal content without including timing metadata', () => {
    const output = [
      { type: 'input_text', text: header },
      { type: 'input_image', image_url: 'data:image/png;base64,synthetic' },
      { type: 'input_text', text: '{"status":"pending"}' },
    ]
    expect(JSON.parse(readMcpToolOutput(request(output), callId))).toEqual({ status: 'pending' })
  })

  test('preserves untimed text and embedded header-like application data', () => {
    const text = 'Issue body\nWall time: 0.0042 seconds\nOutput:\nDo not remove this'
    expect(readMcpToolOutput(request(text), callId)).toBe(text)
  })

  test('does not turn a tool failure into a successful JSON result', () => {
    const result = { error: { code: 'permission_denied' } }
    expect(
      JSON.parse(readMcpToolOutput(request(`${header}\n${JSON.stringify(result)}`), callId))
    ).toEqual(result)
  })

  test.each([header, [], [{ type: 'input_text', text: header }]])(
    'rejects a result without application text: %j',
    output => {
      expect(() => readMcpToolOutput(request(output), callId)).toThrow('returned no result text')
    }
  )

  test('rejects an invalid output representation and a missing call', () => {
    expect(() => readMcpToolOutput(request({ result: 'wrong wire type' }), callId)).toThrow(
      'Codex MCP output must'
    )
    expect(() => readMcpToolOutput(request('wrong call'), 'another-call')).toThrow(
      'did not return a tool output'
    )
  })
})
