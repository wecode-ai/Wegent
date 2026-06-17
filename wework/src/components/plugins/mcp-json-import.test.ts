import { describe, expect, test } from 'vitest'
import { parseCustomMcpJson } from './mcp-json-import'

describe('parseCustomMcpJson', () => {
  test('imports snake_case mcp_servers config', () => {
    const form = parseCustomMcpJson(
      JSON.stringify({
        mcp_servers: {
          'example-mcp': {
            url: 'https://mcp.example.com/mcp',
          },
        },
      })
    )

    expect(form).toMatchObject({
      name: 'example-mcp',
      displayName: 'example-mcp',
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
    })
  })
})
