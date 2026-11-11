// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { executionModelEvents } from '../e2e/desktop/scenarios/stand-in-model-execution.scenario.mjs'
import { RETRY_CONTINUATION_PROMPT } from '../e2e/desktop/modules/shared.mjs'

const marker = 'MODEL_EXECUTION_FIXTURE'
const cases = new Map([
  ['cloud', { upstream: 'kimi-k3' }],
  ['custom', { upstream: 'gpt-5.6-sol' }],
])
const user = content => ({ role: 'user', content })
const wake = user(
  'Wework delegated task result: resultId=result-cloud, taskId=child-cloud, status=done, errorCode=none'
)
const state = () => ({ marker, cases, completed: new Map([['cloud', 'child-cloud']]) })
const retryTaskId = 'stand-in-chat-fixture-primary'
const retryThreadId = 'previous-official-thread'
const retryMessageIds = { request: 'unfinished-request', progress: 'completed-progress' }
const retryPrompt = `${RETRY_CONTINUATION_PROMPT}\nRead authorized history with read_task(${JSON.stringify({ taskId: retryTaskId })}) before continuing.`
const retryHistory = () => ({
  success: true,
  taskId: retryTaskId,
  hasMoreBefore: false,
  messages: [
    { id: 'official-answer', role: 'assistant', content: `${marker}_OFFICIAL_DONE` },
    { id: 'unfinished-request', role: 'user', content: `${marker}_CHAT_cloud` },
    { id: 'completed-progress', role: 'assistant', content: `${marker}_PROGRESS_cloud` },
  ].map(message => ({ ...message, contentComplete: true })),
})
const historyOutput = history => ({
  type: 'function_call_output',
  call_id: 'retry-previous-conversation',
  output: [{ type: 'input_text', text: JSON.stringify(history) }],
})

describe('stand-in execution model fixture', () => {
  test.each([
    ['cloud', 'kimi-k3'],
    ['custom', 'gpt-5.6-sol'],
  ])('validates the exact selected model for %s work', (name, model) => {
    const result = executionModelEvents({ model, input: [user(`${marker}_WORK_${name}`)] }, state())
    expect(result.name).toBe(name)
    expect(JSON.stringify(result.events)).toContain(`${marker}_DONE_${name}`)
    expect(() =>
      executionModelEvents(
        { model: 'wrong-model', input: [user(`${marker}_WORK_${name}`)] },
        state()
      )
    ).toThrow('The selected upstream model must receive the call')
  })

  test('binds a delayed cloud result to its child while a custom case is also registered', () => {
    const result = executionModelEvents(
      {
        model: 'kimi-k3',
        input: [user(`${marker}_CHAT_cloud`), user(`${marker}_CHAT_custom`), wake],
        tools: [{ type: 'tool_search' }],
      },
      state()
    )
    expect(result.name).toBe('cloud')
    expect(JSON.stringify(result.events)).toContain('read_task')
    expect(JSON.stringify(result.events)).not.toContain('create_task')
  })

  test('routes the cloud conversation independently of its previous official session', () => {
    const input = [user(`${marker}_OFFICIAL`), user(`${marker}_CHAT_cloud`)]
    const body = { model: 'kimi-k3', input, tools: [{ type: 'tool_search' }] }
    const result = executionModelEvents(body, state())
    expect(result.name).toBe('cloud')
    expect(JSON.stringify(result.events)).toContain('create_task')
    expect(() => executionModelEvents({ ...body, model: 'gpt-6.1-sol' }, state())).toThrow(
      'The selected upstream model must receive the call'
    )
  })

  test('reads the exact original history before deciding which work a new-session retry continues', () => {
    const context = { ...state(), retryTaskId, retryThreadId, retryMessageIds }
    const body = {
      model: 'kimi-k3',
      input: [user(retryPrompt)],
      tools: [{ type: 'tool_search' }],
    }
    const result = executionModelEvents(body, context)
    expect(result.name).toBe('cloud')
    expect(JSON.stringify(result.events)).toContain('read_task')
    expect(JSON.stringify(result.events)).not.toContain('create_task')
    const direct = executionModelEvents(
      {
        ...body,
        tools: [{ type: 'function', name: 'mcp__wework_stand_in__read_task', parameters: {} }],
      },
      context
    )
    const call = direct.events.find(
      event => event.type === 'response.output_item.done' && event.item?.type === 'function_call'
    ).item
    expect(JSON.parse(call.arguments)).toEqual({ taskId: retryTaskId })
    const resumed = { ...body, input: [...body.input, historyOutput(retryHistory())] }
    const continued = executionModelEvents(resumed, context)
    expect(continued.name).toBe('cloud')
    expect(JSON.stringify(continued.events)).toContain('create_task')
    expect(continued.retryEvidence).toEqual({
      taskId: retryTaskId,
      threadId: retryThreadId,
      name: 'cloud',
      requestMessageId: 'unfinished-request',
      progressMessageId: 'completed-progress',
    })
    expect(() => executionModelEvents({ ...body, model: 'gpt-6.1-sol' }, context)).toThrow(
      'The selected upstream model must receive the call'
    )
    expect(() => executionModelEvents(body, state())).toThrow(
      'Retry must retain its original logical conversation'
    )
    expect(() =>
      executionModelEvents({ ...body, input: [user(`${marker}_OFFICIAL`), ...body.input] }, context)
    ).toThrow('A cross-provider retry must not copy the previous official native session')
    expect(() =>
      executionModelEvents(
        { ...body, input: [user(`${retryPrompt}\n${marker}_CHAT_cloud`)] },
        context
      )
    ).toThrow('Retry must send the continuation prompt rather than replaying the original request')
    expect(() =>
      executionModelEvents({ ...body, input: [user(RETRY_CONTINUATION_PROMPT)] }, context)
    ).toThrow('A new-session retry must identify the exact authorized conversation history')
    expect(() => executionModelEvents({ ...resumed, model: 'gpt-5.6-sol' }, context)).toThrow(
      'The selected upstream model must receive the call'
    )
  })

  test.each([
    [
      'denied history',
      history => {
        history.success = false
      },
      'successfully read real authorized history',
    ],
    [
      'another task',
      history => {
        history.taskId = 'unrelated-task'
      },
      'exact original logical task',
    ],
    [
      'another persisted request',
      history => {
        history.messages[1].id = 'unrelated-request'
      },
      'exact request persisted in the failed original session',
    ],
    [
      'another persisted progress',
      history => {
        history.messages[2].id = 'unrelated-progress'
      },
      'exact completed progress persisted in the failed original session',
    ],
    [
      'missing request',
      history => {
        history.messages = history.messages.filter(message => message.role !== 'user')
      },
      'identify one unfinished request',
    ],
    [
      'missing progress',
      history => {
        history.messages = history.messages.filter(message => message.id !== 'completed-progress')
      },
      'completed progress from the failed native turn',
    ],
    [
      'unread page',
      history => {
        history.hasMoreBefore = true
      },
      'history must fit one page',
    ],
    [
      'truncated message',
      history => {
        history.messages[1].contentComplete = false
      },
      'read complete message content',
    ],
  ])('never guesses the unfinished request from %s', (_name, change, error) => {
    const history = retryHistory()
    change(history)
    expect(() =>
      executionModelEvents(
        {
          model: 'kimi-k3',
          input: [user(retryPrompt), historyOutput(history)],
          tools: [{ type: 'tool_search' }],
        },
        { ...state(), retryTaskId, retryThreadId, retryMessageIds }
      )
    ).toThrow(error)
  })

  test('reports the actual child answer after reading its transcript', () => {
    const context = state()
    const body = {
      model: 'kimi-k3',
      input: [user(`${marker}_CHAT_cloud`), wake],
      tools: [{ type: 'function', name: 'mcp__wework_stand_in__read_task', parameters: {} }],
    }
    const first = executionModelEvents(body, context)
    const call = first.events.find(event => event.item?.type === 'function_call').item
    const result = executionModelEvents(
      {
        ...body,
        input: [
          ...body.input,
          {
            type: 'function_call_output',
            call_id: call.call_id,
            output: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  taskId: 'child-cloud',
                  messages: [{ role: 'assistant', content: `${marker}_DONE_cloud` }],
                }),
              },
            ],
          },
        ],
      },
      context
    )
    expect(result.name).toBe('cloud')
    expect(JSON.stringify(result.events)).toContain(`${marker}_DONE_cloud`)
    expect(JSON.stringify(result.events)).not.toContain('create_task')
  })

  test('does not attribute a delayed cloud call to the currently selected custom model', () => {
    expect(() =>
      executionModelEvents(
        {
          model: 'gpt-5.6-sol',
          input: [user(`${marker}_CHAT_cloud`), wake],
          tools: [{ type: 'tool_search' }],
        },
        state()
      )
    ).toThrow('The selected upstream model must receive the call')
  })

  test('checks a chat option override without changing the delegated work model options', () => {
    const context = state()
    context.cases = new Map([
      [
        'cloud',
        {
          upstream: 'kimi-k3',
          reasoning: 'low',
          conversationReasoning: 'high',
          conversationLimits: { maxOutputTokens: 16_384 },
        },
      ],
    ])
    for (const [kind, reasoning] of [
      ['CHAT', 'high'],
      ['WORK', 'low'],
    ]) {
      const body = {
        model: 'kimi-k3',
        reasoning: { effort: reasoning },
        ...(kind === 'CHAT' ? { max_output_tokens: 16_384 } : {}),
        input: [user(`${marker}_${kind}_cloud`)],
        tools: [{ type: 'tool_search' }],
      }
      expect(executionModelEvents(body, context).name).toBe('cloud')
      expect(() =>
        executionModelEvents({ ...body, reasoning: { effort: 'wrong-effort' } }, context)
      ).toThrow('The selected conversation or work reasoning effort must reach the model')
      if (kind === 'CHAT') {
        expect(() => executionModelEvents({ ...body, max_output_tokens: 4096 }, context)).toThrow(
          'The refreshed output limit must reach the actual primary model request'
        )
      }
    }
  })
})
