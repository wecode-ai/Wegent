import { describe, expect, test } from 'vitest'
import { selectMcpTool } from '../e2e/desktop/modules/response-protocol.mjs'

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
