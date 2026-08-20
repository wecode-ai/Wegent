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

  test('imports a direct Codex remote server map with http_headers', () => {
    const form = parseCustomMcpJson(
      JSON.stringify({
        'example-mcp': {
          url: 'https://mcp.example.com/mcp',
          http_headers: {
            Authorization: 'Bearer token',
            'X-Shared': 'codex',
          },
          headers: {
            'X-Shared': 'legacy',
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
    expect(JSON.parse(form.headersJson)).toEqual({
      Authorization: 'Bearer token',
      'X-Shared': 'legacy',
    })
  })
})
