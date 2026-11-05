// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-identities.scenario.mjs'

vi.mock('../../e2e/desktop/modules/stand-in-dingtalk-fixture.mjs', () => ({
  createStandInDingTalkFixture: () => ({ prepareApp: vi.fn(), install: vi.fn() }),
}))

const { readRequestBody } = vi.hoisted(() => ({ readRequestBody: vi.fn() }))
vi.mock('../../e2e/desktop/modules/response-protocol.mjs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRequestBody,
}))

const marker = 'IDENTITY_CREATE_REVIEW_ROLE'
const request = { method: 'POST' }
const url = new URL('http://fixture/v1/responses')
const createScenario = () => createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1000 })
const createResponse = () => ({ writeHead: vi.fn(), end: vi.fn() })

beforeEach(() => vi.clearAllMocks())

test.each(['prewarm', 'compaction'])(
  'delegates %s containing the role prompt to the shared model handler',
  async kind => {
    const scenario = createScenario()
    const response = createResponse()
    readRequestBody.mockResolvedValue({
      input: [{ role: 'user', content: marker }],
      tools: [],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind }) },
    })

    expect(await scenario.handleHttp(request, response, url)).toBe(false)
    expect(response.writeHead).not.toHaveBeenCalled()
    expect(scenario.diagnostics()).toEqual({ sentProposal: false, requests: [] })
  }
)

test('still rejects a real role turn without advertised tools', async () => {
  readRequestBody.mockResolvedValue({ input: [{ role: 'user', content: marker }], tools: [] })
  await expect(createScenario().handleHttp(request, createResponse(), url)).rejects.toThrow(
    'Real Codex did not advertise exactly one deferred tool search'
  )
})

test('still requests the real deferred role tool for an ordinary turn', async () => {
  const scenario = createScenario()
  const response = createResponse()
  readRequestBody.mockResolvedValue({
    input: [{ role: 'user', content: marker }],
    tools: [{ type: 'tool_search' }],
  })

  expect(await scenario.handleHttp(request, response, url)).toBe(true)
  expect(response.end.mock.calls[0][0]).toContain('tool_search_call')
  expect(response.end.mock.calls[0][0]).toContain('propose_profile')
  expect(scenario.diagnostics()).toEqual({ sentProposal: false, requests: ['proposal'] })
})
