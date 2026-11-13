// @vitest-environment node

import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/connector-oauth.scenario.mjs'

const prompt = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_CALL'
const completion = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_TOOL_COMPLETED'
const callId = 'connector-oauth-real-echo'
const url = new URL('http://model.test/v1/responses')
const execDeclaration = {
  type: 'namespace',
  name: 'functions',
  tools: [
    {
      type: 'custom',
      name: 'exec',
      description: 'Run Code Mode.',
    },
  ],
}

function request(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' })
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() }
}

function events(value: { end: (input: string) => void }) {
  return value.end.mock.calls[0][0]
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)))
}

function itemWithType(events: Array<{ type?: string; item?: { type?: string } }>, type: string) {
  return events.find(
    event => event.type === 'response.output_item.done' && event.item?.type === type
  )?.item
}

function codeModeBody(input: string, output: string, callId: string, includeExec = true) {
  return {
    input: [
      { role: 'user', content: prompt },
      {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
          { type: 'input_text', text: output },
        ],
      },
    ],
    tools: includeExec ? [execDeclaration] : [],
  }
}

test('lazy discovery takes priority over a static call in conversation history', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  expect(
    await scenario.handleHttp(
      request({
        tools: [execDeclaration],
        input: [
          { role: 'user', content: prompt },
          { role: 'user', content: 'WEWORK_DESKTOP_E2E_CONNECTOR_LAZY_CALL' },
        ],
      }),
      modelResponse,
      url
    )
  ).toBe(true)
  const discovery = itemWithType(events(modelResponse), 'custom_tool_call')
  expect(discovery).toMatchObject({ call_id: 'connector-lazy-discover-search', name: 'exec' })
  expect(discovery?.input).toContain('_wegent_discover__desktop_connector_oauth')
  expect(events(modelResponse).some(event => event.item?.call_id === callId)).toBe(false)
})

test.each([
  ['CONNECTOR-OAUTH-ECHO-OK', true],
  ['connector_auth_required', false],
])('lazy completion requires the actual upstream result: %s', async (output, successful) => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const body = codeModeBody('unused', output, 'connector-lazy-echo', false)
  body.input[0].content = 'WEWORK_DESKTOP_E2E_CONNECTOR_LAZY_CALL'
  if (successful) {
    expect(await scenario.handleHttp(request(body), modelResponse, url)).toBe(true)
    expect(itemWithType(events(modelResponse), 'message')?.content[0].text).toBe(
      'WEWORK_DESKTOP_E2E_CONNECTOR_LAZY_COMPLETED'
    )
  } else {
    await expect(scenario.handleHttp(request(body), modelResponse, url)).rejects.toThrow()
    expect(modelResponse.end).not.toHaveBeenCalled()
  }
})

test('the first connector tool request emits native discovery instead of falling through', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  expect(
    await scenario.handleHttp(
      request({
        tools: [execDeclaration],
        input: [{ role: 'user', content: prompt }],
      }),
      modelResponse,
      url
    )
  ).toBe(true)

  const discovery = itemWithType(events(modelResponse), 'custom_tool_call')
  expect(discovery).toMatchObject({ call_id: `${callId}-search`, name: 'exec' })
  expect(discovery?.input).toContain('ALL_TOOLS')
  expect(events(modelResponse).some(event => event.item?.call_id === callId)).toBe(false)
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([discovery])
})

test('Lite incremental Code Mode discovery remains in the completed response', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()

  expect(
    await scenario.handleHttp(
      request({
        input: [
          { type: 'additional_tools', tools: [execDeclaration] },
          { role: 'user', content: prompt },
        ],
      }),
      modelResponse,
      url
    )
  ).toBe(true)

  const discovery = itemWithType(events(modelResponse), 'custom_tool_call')
  expect(discovery).toMatchObject({
    call_id: `${callId}-search`,
    namespace: 'functions',
    name: 'exec',
  })
  expect(discovery?.input).toContain('ALL_TOOLS')
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([discovery])
})

test('the searched connector tool is invoked before completing the real call', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const discovered = {
    name: 'mcp__wegent_apps__desktop_connector_oauth__echo',
    description:
      'Echo the caller payload.\n\nexec tool declaration:\necho(args: { value: string }): Promise<unknown>',
  }
  const body = codeModeBody(
    'unused search script',
    JSON.stringify({ tools: [discovered] }),
    `${callId}-search`
  )

  expect(await scenario.handleHttp(request(body), modelResponse, url)).toBe(true)

  const invocation = itemWithType(events(modelResponse), 'custom_tool_call')
  expect(invocation).toMatchObject({ call_id: callId, name: 'exec' })
  expect(invocation?.input).toContain(discovered.name)
  expect(invocation?.input).toContain(prompt)
  expect(events(modelResponse).some(event => event.item?.type === 'message')).toBe(false)
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([invocation])
})

test('the converted native connector identity progresses from discovery to invocation', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const discovered = {
    name: 'mcp__wegent_apps__desktop_connector_oauth__echo',
    description:
      'Echo the caller payload.\n\nexec tool declaration:\necho(args: { value: string }): Promise<unknown>',
  }
  const body = {
    ...codeModeBody(
      'unused search script',
      JSON.stringify({ tools: [discovered] }),
      `${callId}-search`
    ),
    tools: [
      {
        type: 'function',
        name: 'functions__exec',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    ],
  }
  const modelResponse = response()

  expect(await scenario.handleHttp(request(body), modelResponse, url)).toBe(true)

  const invocation = itemWithType(events(modelResponse), 'function_call')
  expect(invocation).toMatchObject({ call_id: callId, name: 'functions__exec' })
  expect(JSON.parse(invocation?.arguments).input).toContain(discovered.name)
  expect(JSON.parse(invocation?.arguments).input).toContain(prompt)
  expect(scenario.diagnostics().toolRequestDiagnostics[0]).toMatchObject({
    discoveredNamespaces: [{ name: 'wegent_apps__desktop_connector_oauth', toolNames: ['echo'] }],
    responseMode: 'direct',
  })
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([invocation])
})

test('a different connector echo cannot satisfy the authorized connector invocation', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const other = {
    name: 'mcp__wegent_apps__another_connector__echo',
    description: 'exec tool declaration:\necho(args: { value: string }): Promise<unknown>',
  }
  const modelResponse = response()
  const body = codeModeBody(
    'unused search script',
    JSON.stringify({ tools: [other] }),
    `${callId}-search`
  )

  await expect(scenario.handleHttp(request(body), modelResponse, url)).rejects.toThrow(
    'Native discovery did not expose mcp__wegent_apps__desktop_connector_oauth__echo'
  )
  expect(modelResponse.writeHead).not.toHaveBeenCalled()
  expect(modelResponse.end).not.toHaveBeenCalled()
  expect(scenario.diagnostics().toolRequestDiagnostics[0].responseMode).toBe('failure')
})

test('the real connector tool result completes the checkpoint', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const body = codeModeBody('unused invocation script', 'CONNECTOR-OAUTH-ECHO-OK', callId, false)

  expect(await scenario.handleHttp(request(body), modelResponse, url)).toBe(true)

  const message = itemWithType(events(modelResponse), 'message')
  expect(message?.content).toEqual([{ type: 'output_text', text: completion, annotations: [] }])
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([message])
})

test('function-based Code Mode discovery remains in the completed response', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const declaration = {
    type: 'namespace',
    name: 'functions',
    tools: [
      {
        type: 'function',
        name: 'exec',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    ],
  }

  expect(
    await scenario.handleHttp(
      request({ tools: [declaration], input: [{ role: 'user', content: prompt }] }),
      modelResponse,
      url
    )
  ).toBe(true)

  const discovery = itemWithType(events(modelResponse), 'function_call')
  expect(discovery).toMatchObject({
    call_id: `${callId}-search`,
    namespace: 'functions',
    name: 'exec',
  })
  expect(JSON.parse(discovery?.arguments).input).toContain('ALL_TOOLS')
  expect(events(modelResponse).at(-1)?.response?.output).toEqual([discovery])
})

test('an unsuccessful upstream tool result cannot complete the checkpoint', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const body = codeModeBody('unused invocation script', 'connector_auth_required', callId, false)

  await expect(scenario.handleHttp(request(body), modelResponse, url)).rejects.toThrow(
    'The authorized local MCP call must return the upstream success marker'
  )
  expect(modelResponse.end).not.toHaveBeenCalled()
})

test('tool discovery diagnostics identify failures without exposing raw output', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })
  const modelResponse = response()
  const failure = 'Discovery must select between one and eight real native capabilities'
  const body = codeModeBody(
    'unused search script',
    `Error: ${failure}\nBearer fixture-private-value`,
    `${callId}-search`
  )

  const failed = scenario.handleHttp(request(body), modelResponse, url)
  await expect(failed).rejects.toThrow(
    'Native discovery did not expose mcp__wegent_apps__desktop_connector_oauth__echo'
  )
  await expect(failed).rejects.not.toThrow('fixture-private-value')
  expect(modelResponse.writeHead).not.toHaveBeenCalled()
  expect(modelResponse.end).not.toHaveBeenCalled()

  const diagnostic = scenario.diagnostics().toolRequestDiagnostics[0]
  expect(diagnostic).toMatchObject({
    sequence: 1,
    hasCurrentTools: true,
    execDeclarations: [{ type: 'custom', name: 'exec', namespace: 'functions' }],
    searchOutputPresent: true,
    searchOutputSignals: [failure],
    discoveredNamespaces: [],
    invocationOutputPresent: false,
    responseMode: 'failure',
    responseItems: [],
  })
  expect(JSON.stringify(diagnostic)).not.toContain('fixture-private-value')
})

test('tool request diagnostics retain a bounded first-and-last observation window', async () => {
  const scenario = createDesktopScenario({ resultDir: '/fixture', uiTimeoutMs: 1 })

  for (let index = 0; index < 20; index++) {
    expect(
      await scenario.handleHttp(
        request({ tools: [execDeclaration], input: [{ role: 'user', content: prompt }] }),
        response(),
        url
      )
    ).toBe(true)
  }

  const diagnostics = scenario.diagnostics().toolRequestDiagnostics
  expect(diagnostics).toHaveLength(16)
  expect(diagnostics.map(item => item.sequence)).toEqual([
    1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  ])
})
