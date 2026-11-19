// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { readMcpToolOutput } from '../../e2e/desktop/modules/mcp-tool-results.mjs'
import { toolOutputText } from '../../e2e/desktop/modules/response-protocol.mjs'

const callId = 'native-mcp-call'
const header = 'Wall time: 0.0042 seconds\nOutput:'
const request = (output: unknown) => ({
  input: [{ type: 'function_call_output', call_id: callId, output }],
})

describe('native MCP result text', () => {
  test.each(['function_call_output', 'custom_tool_call_output'])(
    'reads the exact bound-Issue call through %s',
    type => {
      const body = {
        input: [
          { type, call_id: 'another-call', output: 'wrong Issue' },
          { type, call_id: callId, output: [{ type: 'input_text', text: 'BOUND_ISSUE_READ_OK' }] },
        ],
      }
      expect(toolOutputText(body, callId)).toBe('BOUND_ISSUE_READ_OK')
      expect(toolOutputText(body, 'missing-call')).toBeNull()
    }
  )
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

  test.each(['failed', 'terminated'])(
    'preserves application text beginning with Script %s',
    status => {
      const text = `Script ${status}\nThe Issue describes a historical execution.`
      const statusLikeText = `Script ${status}\nWall time 0.04 seconds\nOutput:\nHistorical log`
      const completedHeader = 'Script completed\nWall time 0.04 seconds\nOutput:\n'
      for (const [output, expected] of [
        [text, text],
        [[{ type: 'input_text', text }], text],
        [`${completedHeader}${statusLikeText}`, statusLikeText],
        [
          [
            { type: 'input_text', text: completedHeader },
            { type: 'input_text', text: statusLikeText },
          ],
          statusLikeText,
        ],
        [`${header}\n${statusLikeText}`, statusLikeText],
      ] as const) {
        expect(readMcpToolOutput(request(output), callId)).toBe(expected)
      }
    }
  )

  test.each(['failed', 'terminated'])(
    'retains the original native script %s cause before a consumer parses JSON',
    status => {
      const cause = 'Script error:\nNative capability is missing or ambiguous: get_current_context'
      for (const timing of [
        'Wall time 0.04 seconds',
        'Wall time 0.040 seconds (code-mode 0.030 seconds; overhead 0.010 seconds)',
      ]) {
        const nativeHeader = `Script ${status}\n${timing}\nOutput:\n`
        const failure = `${nativeHeader}${cause}`
        for (const output of [
          failure,
          [{ type: 'input_text', text: failure }],
          [
            { type: 'input_text', text: nativeHeader },
            { type: 'input_text', text: cause },
          ],
        ]) {
          const read = () => JSON.parse(readMcpToolOutput(request(output), callId))
          expect(read).toThrow(`Real MCP call ${callId} failed in native Code Mode:`)
          expect(read).toThrow(cause)
        }
      }
    }
  )

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
