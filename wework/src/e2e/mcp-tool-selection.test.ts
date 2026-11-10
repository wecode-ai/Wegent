// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { selectMcpToolRequest } from '../../e2e/desktop/modules/response-protocol.mjs'

const name = 'get_current_context'
const namespace = (name: string) => ({
  type: 'namespace',
  name,
  tools: [{ type: 'function', name: 'get_current_context' }],
})
const search = { type: 'tool_search', name: 'tool_search' }
const searched = (...names: string[]) => ({
  tools: [search],
  input: [{ type: 'tool_search_output', tools: names.map(namespace) }],
})

describe('MCP tool identity in desktop model fixtures', () => {
  test.each([
    ['wework_space', 'wework_control'],
    ['wework_control', 'wework_space'],
  ])('selects %s when another server exposes the same tool', (target, other) => {
    const selection = selectMcpToolRequest(
      searched(other, target),
      name,
      {},
      `mcp__${target}__${name}`
    )
    expect(selection).toEqual({ mode: 'direct', namespace: target, name, arguments: {} })
  })

  test('keeps qualified identity for directly advertised namespaces', () => {
    expect(
      selectMcpToolRequest(
        { tools: [namespace('wework_control'), namespace('wework_space')] },
        name,
        {},
        `mcp__wework_space__${name}`
      )
    ).toMatchObject({ mode: 'direct', namespace: 'wework_space' })
  })

  test('searches the requested server instead of calling a loaded namesake', () => {
    expect(
      selectMcpToolRequest(searched('wework_control'), name, {}, `mcp__wework_space__${name}`)
    ).toMatchObject({ mode: 'search', arguments: { query: `wework_space ${name}` } })
  })

  test('uses qualified search before either server is loaded', () => {
    expect(
      selectMcpToolRequest({ tools: [search] }, name, {}, `mcp__wework_space__${name}`)
    ).toMatchObject({ mode: 'search', arguments: { query: `wework_space ${name}` } })
  })

  test('rejects an ambiguous unqualified tool instead of selecting the first server', () => {
    expect(() =>
      selectMcpToolRequest(searched('wework_control', 'wework_space'), name, {})
    ).toThrow('Ambiguous MCP tool')
  })

  test('allows repeated discovery of the same identity in native request history', () => {
    expect(selectMcpToolRequest(searched('wework_space', 'wework_space'), name, {})).toMatchObject({
      mode: 'direct',
      namespace: 'wework_space',
    })
  })

  test('preserves the native prefixed namespace returned by discovery', () => {
    expect(
      selectMcpToolRequest(searched('mcp__wework_space'), name, {}, `mcp__wework_space__${name}`)
    ).toMatchObject({ mode: 'direct', namespace: 'mcp__wework_space' })
  })

  test('preserves an exact directly advertised function identity', () => {
    const directToolName = `mcp__wework_space__${name}`
    expect(
      selectMcpToolRequest(
        { tools: [{ type: 'function', name: directToolName }] },
        name,
        { item_id: 'issue-1' },
        directToolName
      )
    ).toEqual({ mode: 'direct', name: directToolName, arguments: { item_id: 'issue-1' } })
  })

  test('uses the converted function name while retaining its requested MCP server', () => {
    expect(
      selectMcpToolRequest(
        {
          tools: ['wework_control', 'wework_space'].map(server => ({
            type: 'function',
            name: `${server}__${name}`,
          })),
        },
        name,
        { item_id: 'issue-1' },
        `mcp__wework_space__${name}`
      )
    ).toEqual({
      mode: 'direct',
      name: `wework_space__${name}`,
      arguments: { item_id: 'issue-1' },
    })
  })

  test('does not substitute a converted namesake from another MCP server', () => {
    expect(() =>
      selectMcpToolRequest(
        { tools: [{ type: 'function', name: `wework_control__${name}` }] },
        name,
        {},
        `mcp__wework_space__${name}`
      )
    ).toThrow('Real Codex did not advertise exactly one deferred tool search')
  })
})
