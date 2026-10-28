import { describe, expect, it } from 'vitest'
import { normalizeProcessingBlock } from '@wegent/chat-core/runtime-transcript-blocks'

describe('MCP App transcript projection', () => {
  it('preserves source authority and private UI data through persisted and streaming shapes', () => {
    const result = {
      content: [],
      structuredContent: { count: 1 },
      _meta: { privateMarker: 'widget-only' },
    }
    const block = normalizeProcessingBlock(
      'turn',
      {
        id: 'call',
        type: 'tool',
        tool_name: 'counter.show_app',
        mcp_server: 'counter',
        tool_input: {},
        tool_output: result,
        status: 'done',
      },
      0
    )
    expect(block).toMatchObject({
      id: 'call',
      type: 'tool',
      mcpServer: 'counter',
      toolOutput: result,
    })
    const restored = normalizeProcessingBlock('turn', block, 0)
    expect(restored).toMatchObject({ id: 'call', mcpServer: 'counter', toolOutput: result })
  })
})
