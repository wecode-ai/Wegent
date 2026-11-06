// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { executionModelEvents } from '../e2e/desktop/scenarios/stand-in-model-execution.scenario.mjs'

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
})
