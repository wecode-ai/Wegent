import { describe, expect, test } from 'vitest'
import {
  createSse,
  cors,
  customToolCall,
  functionCall,
  mcpToolRequestEvents,
  requestAdvertisesProgrammaticExec,
  responseCompleted,
  responseCreated,
  serializedOutputReportsSuccess,
  selectMcpTool,
  selectMcpToolRequest,
  selectProgrammaticExec,
  nativeToolCallEvents,
  shellToolCallEvents,
} from '../e2e/desktop/modules/response-protocol.mjs'
import {
  longCodeStreamingEvents,
  textDeltaEvents,
} from '../e2e/desktop/modules/streaming-text-fixture.mjs'

function searchResult(...tools) {
  return {
    type: 'function_call_output',
    output: JSON.stringify({ tools }),
  }
}

function namespace(name, ...toolNames) {
  return {
    type: 'namespace',
    name,
    tools: toolNames.map(toolName => ({ type: 'function', name: toolName })),
  }
}

function functionTool(name) {
  return { type: 'function', name }
}

describe('responses stream fixtures', () => {
  test('keeps long-code reasoning and final text in the same order through completion', () => {
    const stream = longCodeStreamingEvents('long-code')
    const started = stream.start.filter(event => event.type === 'response.output_item.added')
    expect(started.map(event => event.output_index)).toEqual([0, 1])
    expect(started.map(event => event.item.type)).toEqual(['reasoning', 'message'])
    expect(textDeltaEvents(stream.itemId, 'code', 0, stream.outputIndex)[0]).toMatchObject({
      item_id: started[1].item.id,
      output_index: 1,
    })
    const completed = stream.finish.at(-1).response.output
    expect(completed.map(item => item.id)).toEqual(started.map(event => event.item.id))
    expect(completed.map(item => item.status)).toEqual(['completed', 'completed'])
    expect(completed[1].phase).toBe('final_answer')
    expect(
      stream.finish.filter(event => 'output_index' in event).map(event => event.output_index)
    ).toEqual([1, 1])
  })

  test('completes tool items in the final response for Codex turn history', () => {
    const events = [
      responseCreated('response-1'),
      ...functionCall('call-1', 'view_image', { path: '/tmp/image.png' }),
      customToolCall('call-2', 'apply_patch', '*** Begin Patch\n*** End Patch'),
      responseCompleted('response-1'),
    ]
    const completedEvent = createSse(events)
      .split('\n\n')
      .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
      .filter(Boolean)
      .map(line => JSON.parse(line.slice('data: '.length)))
      .find(event => event.type === 'response.completed')

    expect(completedEvent.response.output).toEqual([
      expect.objectContaining({
        id: 'fc_call-1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call-1',
      }),
      expect.objectContaining({
        id: 'fc_call-2',
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-2',
      }),
    ])
    expect(completedEvent.response).toEqual(
      expect.objectContaining({
        object: 'response',
        status: 'completed',
        model: 'wework-desktop-e2e',
        error: null,
        incomplete_details: null,
      })
    )
    expect(completedEvent.response.created_at).toEqual(expect.any(Number))
  })
})

describe('cors', () => {
  test('allows every HTTP method used by desktop application APIs', () => {
    const headers = new Map()
    cors({
      setHeader(name, value) {
        headers.set(name, value)
      },
    })

    expect(headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    )
  })
})

describe('programmatic exec', () => {
  const request = {
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              { type: 'custom', name: 'exec' },
              { type: 'function', name: 'wait' },
            ],
          },
        ],
      },
    ],
  }

  test('executes the same shell command and poll through negotiated programmatic tools', async () => {
    const events = shellToolCallEvents(
      request,
      'business',
      "sh '/plugin/business.sh'",
      '/workspace'
    )
    const call = events[0].item
    expect(call).toMatchObject({
      type: 'custom_tool_call',
      namespace: 'functions',
      name: 'exec',
      call_id: 'business',
    })
    const calls = []
    const output = []
    const tools = {
      exec_command: async params => {
        calls.push(params)
        return 'Process running with session ID 123'
      },
      write_stdin: async params => {
        calls.push(params)
        return 'PLUGIN_RECOVERY_OK'
      },
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    await new AsyncFunction('tools', 'text', call.input)(tools, value => output.push(value))
    const poll = nativeToolCallEvents(request, 'business-poll-1', 'write_stdin', {
      session_id: 123,
      chars: '',
      yield_time_ms: 1000,
    })[0].item
    await new AsyncFunction('tools', 'text', poll.input)(tools, value => output.push(value))
    expect(calls).toEqual([
      { cmd: "sh '/plugin/business.sh'", workdir: '/workspace', yield_time_ms: 1000 },
      { session_id: 123, chars: '', yield_time_ms: 1000 },
    ])
    expect(output).toEqual(['Process running with session ID 123', 'PLUGIN_RECOVERY_OK'])
  })

  test('retains direct native calls and rejects missing shell capabilities', () => {
    const direct = shellToolCallEvents(
      { tools: [functionTool('exec_command')] },
      'business',
      'pwd',
      '/workspace'
    )
    expect(direct.at(-1).item).toMatchObject({
      type: 'function_call',
      name: 'exec_command',
      call_id: 'business',
    })
    expect(() => shellToolCallEvents({ tools: [] }, 'business', 'pwd', '/workspace')).toThrow(
      'did not advertise'
    )
  })

  test('recognizes and selects the Codex additional_tools exec tool', () => {
    expect(requestAdvertisesProgrammaticExec(request)).toBe(true)
    expect(selectProgrammaticExec(request, 'text("ok")')).toEqual({
      name: 'exec',
      input: 'text("ok")',
    })
  })

  test('rejects requests without exactly one exec tool', () => {
    expect(requestAdvertisesProgrammaticExec({ input: [] })).toBe(false)
    expect(() => selectProgrammaticExec({ input: [] }, 'text("ok")')).toThrow(
      'Real Codex did not advertise exactly one programmatic exec tool: 0'
    )

    const duplicateExecRequest = { input: [request.input[0], request.input[0]] }
    expect(requestAdvertisesProgrammaticExec(duplicateExecRequest)).toBe(true)
    expect(() => selectProgrammaticExec(duplicateExecRequest, 'text("ok")')).toThrow(
      'Real Codex did not advertise exactly one programmatic exec tool: 2'
    )
  })

  test('recognizes compact, formatted, and escaped success output', () => {
    expect(serializedOutputReportsSuccess('{"ok":true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{"ok": true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{\\"ok\\":true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{"ok":false}')).toBe(false)
  })
})

describe('selectMcpTool', () => {
  test('selects a tool from a later result for the same namespace', () => {
    const request = {
      input: [
        searchResult(namespace('wework_space', 'get_board_item')),
        searchResult(namespace('wework_space', 'get_assignment_candidates')),
      ],
    }

    expect(selectMcpTool(request, 'wework_space', 'get_assignment_candidates', {})).toEqual({
      namespace: 'wework_space',
      name: 'get_assignment_candidates',
      arguments: {},
    })
  })

  test('reports when the requested namespace is missing', () => {
    const request = {
      input: [searchResult(namespace('another_namespace', 'get_assignment_candidates'))],
    }

    expect(() => selectMcpTool(request, 'wework_space', 'get_assignment_candidates', {})).toThrow(
      'tool_search did not return MCP namespace wework_space'
    )
  })

  test('reports when no matching namespace result exposes the requested tool', () => {
    const request = {
      input: [
        searchResult(namespace('wework_space', 'get_board_item')),
        searchResult(namespace('wework_space', 'submit_workflow_plan')),
      ],
    }

    expect(() => selectMcpTool(request, 'wework_space', 'get_assignment_candidates', {})).toThrow(
      'Searched MCP namespace wework_space did not expose get_assignment_candidates'
    )
  })
})

describe('selectMcpToolRequest', () => {
  test('uses direct Chat Shell calls throughout the manager state machine', () => {
    const request = {
      tools: [
        functionTool('load_skill'),
        functionTool('wegent-wework-space_get_board_item'),
        functionTool('wegent-wework-space_get_assignment_candidates'),
        functionTool('wegent-wework-space_submit_workflow_plan'),
      ],
    }
    const plan = { summary: 'Assign the project robot', items: [] }
    const steps = [
      {
        toolName: 'get_board_item',
        argumentsValue: {},
        searchCallId: 'search-board-item',
        toolCallId: 'read-board-item',
        directToolName: 'wegent-wework-space_get_board_item',
      },
      {
        toolName: 'get_assignment_candidates',
        argumentsValue: {},
        searchCallId: 'search-candidates',
        toolCallId: 'read-candidates',
        directToolName: 'wegent-wework-space_get_assignment_candidates',
      },
      {
        toolName: 'submit_workflow_plan',
        argumentsValue: { plan },
        searchCallId: 'search-submit-plan',
        toolCallId: 'submit-workflow-plan',
        directToolName: 'wegent-wework-space_submit_workflow_plan',
      },
    ]

    for (const step of steps) {
      const response = mcpToolRequestEvents(request, step)
      const completedCall = response.events.find(
        event => event.type === 'response.output_item.done'
      )

      expect(response.mode).toBe('direct')
      expect(completedCall?.item).toMatchObject({
        type: 'function_call',
        call_id: step.toolCallId,
        name: step.directToolName,
      })
      expect(completedCall?.item?.arguments).toBe(JSON.stringify(step.argumentsValue))
      expect(response.events.some(event => event.item?.call_id === step.searchCallId)).toBe(false)
    }
  })

  test('retains the deferred search path whenever Codex advertises it', () => {
    const request = {
      tools: [
        functionTool('load_skill'),
        functionTool('wegent-wework-space_get_board_item'),
        functionTool('search_deferred_tools'),
      ],
    }
    const response = mcpToolRequestEvents(request, {
      toolName: 'get_board_item',
      argumentsValue: {},
      directToolName: 'wegent-wework-space_get_board_item',
      searchCallId: 'search-board-item',
      toolCallId: 'read-board-item',
    })
    const completedCall = response.events.find(event => event.type === 'response.output_item.done')

    expect(response.mode).toBe('search')
    expect(completedCall?.item).toMatchObject({
      type: 'function_call',
      call_id: 'search-board-item',
      name: 'search_deferred_tools',
    })
    expect(completedCall?.item?.arguments).toBe(
      JSON.stringify({ query: 'get_board_item', limit: 8 })
    )
    expect(response.events.some(event => event.item?.call_id === 'read-board-item')).toBe(false)
  })

  test('still rejects a Codex request without exactly one deferred search', () => {
    const request = { tools: [functionTool('load_skill')] }

    expect(() => selectMcpToolRequest(request, 'get_board_item', {})).toThrow(
      'Real Codex did not advertise exactly one deferred tool search'
    )
  })
})
