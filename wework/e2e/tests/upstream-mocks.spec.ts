import { expect, test } from '@playwright/test'

const sitesUpstreamMockUrl = process.env.WEWORK_SITES_UPSTREAM_MOCK_URL || 'http://127.0.0.1:9997'
const connectorUpstreamMockUrl =
  process.env.WEWORK_CONNECTOR_UPSTREAM_MOCK_URL || 'http://127.0.0.1:9996'

test('serves Sites upstream project API mock responses', async ({ request }) => {
  await request.post(`${sitesUpstreamMockUrl}/reset`)

  const searchResponse = await request.get(
    `${sitesUpstreamMockUrl}/api/v1/projects/search?username=alice&limit=1&sitename=product`,
    {
      headers: {
        Authorization: 'Bearer e2e-sites-token',
      },
    }
  )
  const searchBody = await searchResponse.json()
  const projectId = searchBody.items[0].id

  const publishResponse = await request.post(
    `${sitesUpstreamMockUrl}/api/v1/projects/deploy/network`,
    {
      headers: {
        Authorization: 'Bearer e2e-sites-token',
      },
      data: {
        username: 'alice',
        project_id: projectId,
        network: 'outer',
      },
    }
  )
  const publishBody = await publishResponse.json()
  const captured = await request
    .get(`${sitesUpstreamMockUrl}/captured-requests`)
    .then(res => res.json())

  expect(searchResponse.status()).toBe(200)
  expect(searchResponse.headers()['access-control-allow-origin']).toBe('*')
  expect(searchBody.items[0]).toMatchObject({
    id: 'prj_e2e_product',
    title: 'E2E Product Site',
  })
  expect(publishResponse.status()).toBe(200)
  expect(publishBody).toMatchObject({
    id: 'prj_e2e_product',
    network: 'outer',
  })
  expect(JSON.stringify(captured)).toContain('/api/v1/projects/search')
  expect(JSON.stringify(captured)).toContain('/api/v1/projects/deploy/network')
})

test('serves connector HTTP tool and MCP upstream mock responses', async ({ request }) => {
  await request.post(`${connectorUpstreamMockUrl}/clear-requests`)

  const ticketResponse = await request.get(
    `${connectorUpstreamMockUrl}/api/tickets/T%2F42?expand=true`,
    {
      headers: {
        Authorization: 'Bearer fixed-provider-token',
        'X-Wegent-Username': 'alice',
      },
    }
  )
  const ticketBody = await ticketResponse.json()

  const initializeResponse = await request.post(`${connectorUpstreamMockUrl}/mcp`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wework-e2e', version: '0.1.0' },
      },
    },
  })
  const initializeBody = await initializeResponse.json()

  const toolsResponse = await request.post(`${connectorUpstreamMockUrl}/mcp`, {
    headers: {
      'Mcp-Session-Id': initializeResponse.headers()['mcp-session-id'] || '',
    },
    data: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
  })
  const toolsBody = await toolsResponse.json()

  const callResponse = await request.post(`${connectorUpstreamMockUrl}/mcp`, {
    data: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'search_docs',
        arguments: { query: 'release notes' },
      },
    },
  })
  const callBody = await callResponse.json()
  const captured = await request
    .get(`${connectorUpstreamMockUrl}/captured-requests`)
    .then(res => res.json())

  expect(ticketResponse.status()).toBe(200)
  expect(ticketBody).toMatchObject({
    id: 'T/42',
    received_user: 'alice',
    received_authorization: 'Bearer fixed-provider-token',
  })
  expect(initializeResponse.status()).toBe(200)
  expect(initializeBody.result.serverInfo.name).toBe('wegent-e2e-connector-upstream')
  expect(toolsResponse.status()).toBe(200)
  expect(toolsBody.result.tools.map((tool: { name: string }) => tool.name)).toContain('search_docs')
  expect(callResponse.status()).toBe(200)
  expect(callBody.result.structuredContent.results[0].id).toBe('doc-1')
  expect(JSON.stringify(captured)).not.toContain('/oauth/')
  expect(JSON.stringify(captured)).toContain('/api/tickets/T%2F42')
  expect(JSON.stringify(captured)).toContain('tools/list')
})
