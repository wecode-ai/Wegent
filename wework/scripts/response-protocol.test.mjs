import { describe, expect, test } from 'vitest'
import {
  cors,
  mcpToolRequestEvents,
  selectMcpTool,
  selectMcpToolRequest,
} from '../e2e/desktop/modules/response-protocol.mjs'

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
