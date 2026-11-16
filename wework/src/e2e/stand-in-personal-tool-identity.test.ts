// @vitest-environment node

import { Readable } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-personal-task.scenario.mjs'

const title = 'ISSUE_COLLABORATION_WITHOUT_EXTRA_CONFIRMATION manual task'
const name = 'get_current_context'
const namespace = (name: string) => ({
  type: 'namespace',
  name,
  tools: [{ type: 'function', name: 'get_current_context' }],
})

afterEach(() => vi.unstubAllGlobals())

test.each(['deferred', 'flat'])(
  'personal stand-in calls the collaboration server with same-named %s tools present',
  async representation => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname
        let result: unknown
        if (path === '/api/admin/setup-complete' || path === '/api/v1/workspaces/workspace/members')
          result = {}
        else if (path === '/api/users/me' || path === '/api/admin/users') result = { id: 'user' }
        else if (path === '/api/auth/login') result = { access_token: 'synthetic' }
        else if (path === '/api/v1/workspaces') result = { id: 'workspace' }
        else if (path === '/api/v1/workspaces/workspace/projects') result = { id: 'project' }
        else if (path === '/api/v1/cloud-projects/project/loop-items')
          result = { id: 'issue', title }
        else throw new Error(`Unexpected fixture request: ${url}`)
        return new Response(JSON.stringify(result), { status: 200 })
      })
    )
    const scenario = createDesktopScenario({ uiTimeoutMs: 1000, modelResponseTimeoutMs: 1000 })
    await scenario.prepareCloud({ backendUrl: 'http://backend.test', authToken: 'synthetic' })
    const body = {
      tools:
        representation === 'deferred'
          ? [{ type: 'tool_search', name: 'tool_search' }]
          : ['wework_control', 'wework_space'].map(server => ({
              type: 'function',
              name: `mcp__${server}__${name}`,
            })),
      input: [
        {
          role: 'user',
          content: `${title}. Collaboration actions within that scope do not require separate user confirmation`,
        },
        ...(representation === 'deferred'
          ? [
              {
                type: 'tool_search_output',
                tools: ['wework_control', 'wework_space'].map(namespace),
              },
            ]
          : []),
      ],
    }
    const request = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' })
    const response = { writeHead: vi.fn(), end: vi.fn() }
    expect(
      await scenario.handleHttp(request, response, new URL('http://model.test/responses'))
    ).toBe(true)
    const events = (response.end.mock.calls[0][0] as string)
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
    const call = events.find(event => event.item?.type === 'function_call')?.item
    expect(call).toMatchObject(
      representation === 'deferred'
        ? { namespace: 'wework_space', name }
        : { name: `mcp__wework_space__${name}` }
    )
  }
)
