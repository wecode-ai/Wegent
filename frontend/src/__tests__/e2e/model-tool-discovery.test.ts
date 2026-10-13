import {
  deferredToolSearchCall,
  modelToolDefinitions,
  modelToolMatches,
} from '../../../e2e/utils/model-tool-discovery'

describe('mock model deferred tool discovery', () => {
  const search = { type: 'function', function: { name: 'search_deferred_tools' } }

  it('searches missing tools before issuing a scenario call', () => {
    expect(deferredToolSearchCall({ tools: [search] }, ['wework_space__get_board_item'])).toEqual({
      toolName: 'search_deferred_tools',
      arguments: { query: 'get_board_item', limit: 1 },
    })
  })

  it('recognizes discovered tools in JSON-encoded tool-search output', () => {
    const request = {
      tools: [search],
      input: [
        {
          type: 'function_call_output',
          output: JSON.stringify({
            tools: [{ type: 'function', name: 'wework_space__get_board_item' }],
          }),
        },
      ],
    }
    expect(deferredToolSearchCall(request, ['wework_space__get_board_item'])).toBeNull()
    expect(modelToolDefinitions(request).map(tool => tool.name)).toContain(
      'wework_space__get_board_item'
    )
  })

  it('preserves namespaces and excludes ordinary function calls from definitions', () => {
    const tools = modelToolDefinitions({
      tools: [
        {
          type: 'namespace',
          name: 'wework_space',
          tools: [{ type: 'function', name: 'get_board_item' }],
        },
      ],
      input: [{ type: 'function_call', name: 'get_document_info', arguments: '{}' }],
    })
    expect(tools).toEqual([{ name: 'get_board_item', namespace: 'wework_space' }])
    expect(modelToolMatches(tools[0], 'wework_space__get_board_item')).toBe(true)
  })

  it('discovers multiple missing tools one at a time', () => {
    expect(
      deferredToolSearchCall({ tools: [search, { name: 'get_board_item' }] }, [
        'get_board_item',
        'get_document_info',
      ])?.arguments.query
    ).toBe('get_document_info')
  })

  it('fails explicitly when a completed search did not expose the required tool', () => {
    expect(() =>
      deferredToolSearchCall(
        {
          tools: [search],
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  function: {
                    name: 'search_deferred_tools',
                    arguments: JSON.stringify({ query: 'get_board_item' }),
                  },
                },
              ],
            },
            { role: 'tool', content: JSON.stringify({ tools: [] }) },
          ],
        },
        ['wework_space__get_board_item']
      )
    ).toThrow('Deferred tool search did not make wework_space__get_board_item available')
  })
})
