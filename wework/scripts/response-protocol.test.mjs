// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { generateCollaborationGroupDraft } from '../src/features/collaboration/collaborationGroupDraftGeneration'
import { handleProjectCreateGroupModel } from '../e2e/desktop/modules/project-create-group-model.mjs'
import {
  createSse,
  delegatedTaskResultEvents,
  cors,
  customToolCall,
  functionCall,
  mcpToolRequestEvents,
  requestAdvertisesProgrammaticExec,
  responseCompleted,
  responseCreated,
  serializedOutputReportsSuccess,
  selectMcpTool,
  selectMcpToolRequest,
  selectProgrammaticExec,
  selectTool,
  toolOutputText,
} from '../e2e/desktop/modules/response-protocol.mjs'

test('returns a real Responses stream accepted by the production group prompt and draft parser', async () => {
  const input = {
    projectName: 'Protocol generation',
    projectDescription: 'Verify the model boundary',
    generationInstructions: 'PROJECT_CREATE_GROUP_DRAFT_E2E generate responsibilities',
    currentUser: { id: 91, name: 'Project owner' },
    members: [],
    agents: [
      { id: 'team:protocol-alpha', name: 'Planner' },
      { id: 'team:protocol-beta', name: 'Implementer' },
    ],
    modelSelection: { modelName: 'protocol-cloud-model', modelType: 'public' },
  }
  const progress = []
  const draft = await generateCollaborationGroupDraft({
    input,
    onEvent: event => progress.push(event),
    textGenerationApi: {
      async generateText(data) {
        expect(data.outputSchema.properties.events.type).toBe('array')
        const payload = {
          model: data.modelId,
          stream: true,
          text: { format: { type: 'json_schema', name: 'group_draft', schema: data.outputSchema } },
          input: [{ role: 'user', content: [{ type: 'input_text', text: data.prompt }] }],
        }
        const request = Readable.from([gzipSync(Buffer.from(JSON.stringify(payload)))])
        request.method = 'POST'
        request.headers = { 'content-encoding': 'gzip' }
        let wire = ''
        const handled = await handleProjectCreateGroupModel(
          request,
          {
            writeHead(status, headers) {
              expect(status).toBe(200)
              expect(headers['content-type']).toContain('text/event-stream')
            },
            end(chunk) {
              wire += chunk
            },
          },
          new URL('http://model-fixture/v1/responses')
        )
        expect(handled).toBe(true)
        const events = wire
          .trim()
          .split('\n\n')
          .map(frame =>
            JSON.parse(
              frame
                .split('\n')
                .find(line => line.startsWith('data: '))
                .slice(6)
            )
          )
        expect(events[0].type).toBe('response.created')
        const completed = events.at(-1)
        expect(completed.type).toBe('response.completed')
        const text = completed.response.output[0].content[0].text
        data.onDelta?.(text)
        return text
      },
    },
  })
  expect(draft.leader.id).toBe(String(input.currentUser.id))
  expect(draft.members.map(member => member.id)).toEqual(input.agents.map(agent => agent.id))
  expect(draft.members.every(member => member.responsibility.length > 300)).toBe(true)
  expect(draft.stages).toHaveLength(3)
  expect(
    progress
      .filter(event => event.type === 'participant_started')
      .map(({ kind, id }) => `${kind}:${id}`)
  ).toEqual(['human:91', 'agent:team:protocol-alpha', 'agent:team:protocol-beta'])
})

test('leaves ordinary model requests and unrelated HTTP routes to the existing scenario handler', async () => {
  for (const [path, content] of [
    ['/v1/responses', 'PROJECT_CREATE_GROUP_DRAFT_E2E is mentioned by ordinary task history'],
    ['/v1/chat/completions', '你是项目协作架构师。 PROJECT_CREATE_GROUP_DRAFT_E2E'],
  ]) {
    const request = Readable.from([
      JSON.stringify({ model: 'ordinary-model', input: [{ role: 'user', content }] }),
    ])
    request.method = 'POST'
    let replied = false
    expect(
      await handleProjectCreateGroupModel(
        request,
        {
          end() {
            replied = true
          },
        },
        new URL(`http://model-fixture${path}`)
      )
    ).toBe(false)
    expect(replied).toBe(false)
  }
})

describe('native function selection', () => {
  test.each([
    [{ type: 'function', name: 'request_user_input' }, 'request_user_input', undefined],
    [
      {
        type: 'namespace',
        name: 'functions',
        tools: [{ type: 'function', name: 'request_user_input' }],
      },
      'request_user_input',
      'functions',
    ],
    [
      { type: 'function', name: 'functions__request_user_input' },
      'functions__request_user_input',
      undefined,
    ],
  ])(
    'selects the advertised native question tool before Code Mode: %j',
    (tool, name, namespace) => {
      const request = {
        tools: [
          {
            type: 'function',
            name: 'functions__exec',
            parameters: { properties: { input: { type: 'string' } } },
          },
          tool,
        ],
      }
      const args = { questions: [{ id: 'direction', question: 'Which direction?' }] }
      expect(selectTool(request, 'request_user_input', args)).toEqual({
        name,
        arguments: args,
        ...(namespace ? { namespace } : {}),
      })
    }
  )

  test('rejects ambiguous native function declarations', () => {
    expect(() =>
      selectTool(
        {
          tools: [
            { type: 'function', name: 'request_user_input' },
            { type: 'function', name: 'functions__request_user_input' },
          ],
        },
        'request_user_input',
        {}
      )
    ).toThrow(/exactly one/)
  })

  test('selects the flattened asynchronous question tool directly', () => {
    const body = {
      tools: [
        { type: 'custom', name: 'exec' },
        { type: 'function', name: 'functions__request_user_input_async' },
      ],
    }
    expect(selectTool(body, 'request_user_input_async', { questions: [] })).toEqual({
      name: 'functions__request_user_input_async',
      arguments: { questions: [] },
    })
  })
})
import { textDeltaEvents } from '../e2e/desktop/modules/streaming-text-fixture.mjs'

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

describe('responses stream fixtures', () => {
  test('completes tool items in the final response for Codex turn history', () => {
    const events = [
      responseCreated('response-1'),
      ...functionCall('call-1', 'view_image', { path: '/tmp/image.png' }),
      customToolCall('call-2', 'apply_patch', '*** Begin Patch\n*** End Patch'),
      responseCompleted('response-1'),
    ]
    const completedEvent = createSse(events)
      .split('\n\n')
      .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
      .filter(Boolean)
      .map(line => JSON.parse(line.slice('data: '.length)))
      .find(event => event.type === 'response.completed')

    expect(completedEvent.response.output).toEqual([
      expect.objectContaining({
        id: 'fc_call-1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call-1',
      }),
      expect.objectContaining({
        id: 'fc_call-2',
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-2',
      }),
    ])
    expect(completedEvent.response).toEqual(
      expect.objectContaining({
        object: 'response',
        status: 'completed',
        model: 'wework-desktop-e2e',
        error: null,
        incomplete_details: null,
      })
    )
    expect(completedEvent.response.created_at).toEqual(expect.any(Number))
  })
})

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

describe('programmatic exec', () => {
  test.each(['function_call_output', 'custom_tool_call_output'])(
    'reads bound-Issue results from %s envelopes',
    type => {
      const request = {
        input: [
          { type, call_id: 'unrelated', output: 'unrelated result' },
          { type, call_id: 'manual-read', output: 'BOARD_READ_OK' },
        ],
      }
      expect(toolOutputText(request, 'manual-read')).toBe('BOARD_READ_OK')
      expect(toolOutputText({ input: [{ content: request.input }] }, 'manual-read')).toBe(
        'BOARD_READ_OK'
      )
    }
  )
  test('recognizes the native exec declaration before additional tools are injected', () => {
    const request = { tools: [{ type: 'custom', name: 'exec' }], input: [] }
    expect(requestAdvertisesProgrammaticExec(request)).toBe(true)
    expect(selectProgrammaticExec(request, 'text("ok")')).toEqual({
      name: 'exec',
      input: 'text("ok")',
    })
  })
  const request = {
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              { type: 'custom', name: 'exec' },
              { type: 'function', name: 'wait' },
            ],
          },
        ],
      },
    ],
  }

  test('recognizes and selects the Codex additional_tools exec tool', () => {
    expect(requestAdvertisesProgrammaticExec(request)).toBe(true)
    expect(selectProgrammaticExec(request, 'text("ok")')).toEqual({
      name: 'exec',
      input: 'text("ok")',
      namespace: 'functions',
    })
  })

  test('rejects requests without exactly one exec tool', () => {
    expect(requestAdvertisesProgrammaticExec({ input: [] })).toBe(false)
    expect(() => selectProgrammaticExec({ input: [] }, 'text("ok")')).toThrow(
      'Real Codex did not advertise exactly one programmatic exec tool: 0'
    )

    const duplicateExecRequest = {
      input: [
        request.input[0],
        {
          ...request.input[0],
          tools: request.input[0].tools.map(tool => ({ ...tool, name: 'other_functions' })),
        },
      ],
    }
    expect(requestAdvertisesProgrammaticExec(duplicateExecRequest)).toBe(true)
    expect(() => selectProgrammaticExec(duplicateExecRequest, 'text("ok")')).toThrow(
      'Real Codex did not advertise exactly one programmatic exec tool: 2'
    )
  })

  test('recognizes compact, formatted, and escaped success output', () => {
    expect(serializedOutputReportsSuccess('{"ok":true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{"ok": true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{\\"ok\\":true}')).toBe(true)
    expect(serializedOutputReportsSuccess('{"ok":false}')).toBe(false)
  })
})

describe('selectMcpTool', () => {
  test('uses the current search namespace after a runtime rematerializes its MCP server', () => {
    const request = {
      input: [
        { ...searchResult(namespace('sites', 'confirm_access')), call_id: 'earlier' },
        { ...searchResult(namespace('mcp__sites', 'confirm_access')), call_id: 'current' },
        { ...searchResult(namespace('another_site', 'confirm_access')), call_id: 'foreign' },
      ],
    }

    expect(selectMcpTool(request, 'sites', 'confirm_access', {}, 'current')).toEqual({
      namespace: 'mcp__sites',
      name: 'confirm_access',
      arguments: {},
    })
    expect(() => selectMcpTool(request, 'sites', 'confirm_access', {}, 'missing')).toThrow(
      'tool_search did not return MCP namespace sites'
    )
    expect(() => selectMcpTool(request, 'sites', 'confirm_access', {}, 'foreign')).toThrow(
      'tool_search did not return MCP namespace sites'
    )
  })

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
  test('discovers a newly announced native namespace without replaying a failed call ID', () => {
    const step = {
      toolName: 'read_task',
      directToolName: 'mcp__wework_stand_in__read_task',
      argumentsValue: { taskId: 'child-task' },
      searchCallId: 'search-child',
      toolCallId: 'read-child',
    }
    const failure = {
      type: 'custom_tool_call_output',
      call_id: step.searchCallId,
      output: 'Native discovery requires one exact capability',
    }
    const announcement = {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: '<tools>\nAdded deferred tool namespaces:\n- wework_stand_in\n</tools>',
        },
      ],
    }
    const request = { tools: [{ type: 'custom', name: 'exec' }], input: [failure, announcement] }
    const response = mcpToolRequestEvents(request, step)
    const call = response.events.find(event => event.type === 'response.output_item.done').item
    expect(response.mode).toBe('search')
    expect(call.call_id).not.toBe(step.searchCallId)
    expect(call.input).toContain('wework_stand_in__read_task')
    expect(() =>
      mcpToolRequestEvents(
        { ...request, input: [failure, announcement, { ...failure, call_id: call.call_id }] },
        step
      )
    ).toThrow('Native discovery did not expose')
    expect(() =>
      mcpToolRequestEvents({ ...request, input: [announcement, failure] }, step)
    ).toThrow('Native discovery did not expose')
    expect(() =>
      mcpToolRequestEvents(
        { ...request, input: [failure, { ...announcement, role: 'user' }] },
        step
      )
    ).toThrow('Native discovery did not expose')
  })

  test('reports the exact failed discovery instead of repeating it until the UI times out', () => {
    const request = {
      tools: [{ type: 'custom', name: 'exec' }],
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'other-search',
          output: 'Unrelated discovery output',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'search-context',
          output: 'Native discovery execution failed',
        },
      ],
    }
    expect(() =>
      mcpToolRequestEvents(request, {
        toolName: 'get_current_context',
        directToolName: 'mcp__wework_space__get_current_context',
        argumentsValue: {},
        searchCallId: 'search-context',
        toolCallId: 'read-context',
      })
    ).toThrow(
      'Native discovery did not expose mcp__wework_space__get_current_context: Native discovery execution failed'
    )
  })

  test('does not select a same-named tool from another MCP server', () => {
    expect(() =>
      selectMcpToolRequest(
        { tools: [functionTool('another_server__list_tasks')] },
        'list_tasks',
        {},
        'mcp__wework_stand_in__list_tasks'
      )
    ).toThrow('Real Codex did not advertise exactly one deferred tool search')
  })

  test('rejects ambiguous advertised direct MCP identities', () => {
    expect(() =>
      selectMcpToolRequest(
        {
          tools: [
            functionTool('wework_stand_in__list_tasks'),
            functionTool('mcp__wework_stand_in__list_tasks'),
          ],
        },
        'list_tasks',
        {},
        'mcp__wework_stand_in__list_tasks'
      )
    ).toThrow('Ambiguous direct MCP tool')
  })

  test.each(['wework_stand_in__list_tasks', 'mcp__wework_stand_in__list_tasks'])(
    'calls the exact advertised direct MCP name %s without inventing tool search',
    name => {
      const response = mcpToolRequestEvents(
        { tools: [functionTool(name)] },
        {
          toolName: 'list_tasks',
          directToolName: 'mcp__wework_stand_in__list_tasks',
          argumentsValue: { limit: 50 },
          searchCallId: 'search-tasks',
          toolCallId: 'list-tasks',
        }
      )
      const call = response.events.find(event => event.type === 'response.output_item.done').item
      expect(response.mode).toBe('direct')
      expect(call.name).toBe(name)
      expect(JSON.parse(call.arguments)).toEqual({ limit: 50 })
      expect(call.call_id).toBe('list-tasks')
    }
  )

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

describe('delegated task completion model routing', () => {
  const callback = command => ({
    tools: [{ type: 'function', name: 'mcp__wework_stand_in__read_task' }],
    input: [
      {
        role: 'user',
        content: `Wework delegated task result: resultId=${command}, taskId=child-1, status=done, requestCommandId=${command}. Read this exact task with read_task.`,
      },
    ],
  })
  const toolCall = events =>
    events.find(
      event => event.type === 'response.output_item.done' && event.item?.type === 'function_call'
    ).item
  const output = (callId, history) => ({
    type: 'function_call_output',
    call_id: callId,
    output: [{ type: 'input_text', text: JSON.stringify(history) }],
  })

  test('reads the exact real child task before reporting its actual answer', () => {
    const body = callback('first')
    const call = toolCall(delegatedTaskResultEvents(body))
    expect(call.name).toBe('mcp__wework_stand_in__read_task')
    expect(JSON.parse(call.arguments)).toEqual({ taskId: 'child-1' })
    body.input.push(
      output(call.call_id, {
        taskId: 'child-1',
        messages: [{ role: 'assistant', content: 'THE_ACTUAL_CHILD_RESULT' }],
      })
    )
    expect(JSON.stringify(delegatedTaskResultEvents(body))).toContain('THE_ACTUAL_CHILD_RESULT')
    expect(JSON.stringify(delegatedTaskResultEvents(body))).toContain('child-1')
  })

  test('a later completion command cannot reuse an earlier result read', () => {
    const first = callback('first')
    const previousCall = toolCall(delegatedTaskResultEvents(first))
    const next = callback('next')
    next.input.push(
      output(previousCall.call_id, {
        taskId: 'child-1',
        messages: [{ role: 'assistant', content: 'OLD_RESULT' }],
      })
    )
    const nextCall = toolCall(delegatedTaskResultEvents(next))
    expect(nextCall.call_id).not.toBe(previousCall.call_id)
    expect(JSON.parse(nextCall.arguments)).toEqual({ taskId: 'child-1' })
  })

  test('retries a failed Code Mode read on the resumed native conversation', () => {
    const body = callback('first')
    const firstCall = toolCall(delegatedTaskResultEvents(body))
    body.input.push({
      type: 'function_call_output',
      call_id: firstCall.call_id,
      output: 'Script failed\nWall time 0.1 seconds\nOutput:\nMCP catalog is still starting',
    })

    const retryCall = toolCall(delegatedTaskResultEvents(body))
    expect(retryCall.call_id).toBe(`${firstCall.call_id}-retry-1`)
    body.input.push(
      output(retryCall.call_id, {
        taskId: 'child-1',
        messages: [{ role: 'assistant', content: 'THE_ACTUAL_CHILD_RESULT' }],
      })
    )
    expect(JSON.stringify(delegatedTaskResultEvents(body))).toContain('THE_ACTUAL_CHILD_RESULT')
  })

  test('rejects an incorrect child transcript or a completed task without an answer', () => {
    for (const history of [
      { taskId: 'other-child', messages: [] },
      { taskId: 'child-1', messages: [] },
    ]) {
      const body = callback('first')
      const call = toolCall(delegatedTaskResultEvents(body))
      body.input.push(output(call.call_id, history))
      expect(() => delegatedTaskResultEvents(body)).toThrow()
    }
  })

  test('quoted callback text in tool evidence does not become a new callback', () => {
    const body = {
      input: [
        { role: 'user', content: 'Continue ordinary work' },
        {
          type: 'function_call_output',
          call_id: 'evidence',
          output: JSON.stringify(callback('first')),
        },
      ],
    }
    expect(delegatedTaskResultEvents(body)).toBeNull()
  })
})
