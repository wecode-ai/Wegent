import { hasCompletedProviderNativeTurn } from '../../../e2e/utils/provider-native-task-turn'

const PROMPT = 'second unique prompt'
const oldTurn = [
  { id: 15, role: 'USER', message_id: 1, prompt: 'first prompt', status: 'COMPLETED' },
  { id: 16, role: 'ASSISTANT', message_id: 2, parent_id: 1, status: 'COMPLETED' },
]
const user = { id: 17, role: 'USER', message_id: 3, prompt: PROMPT, status: 'COMPLETED' }
const assistant = { id: 18, role: 'ASSISTANT', message_id: 4, parent_id: 3, status: 'RUNNING' }

describe('provider-native follow-up completion', () => {
  it('does not accept the previous completed turn before this prompt is persisted', () => {
    expect(hasCompletedProviderNativeTurn({ status: 'COMPLETED', subtasks: oldTurn }, PROMPT)).toBe(
      false
    )
  })

  it('waits for the reply to this prompt even when task completion is stale', () => {
    expect(
      hasCompletedProviderNativeTurn(
        { status: 'COMPLETED', subtasks: [...oldTurn, user, assistant] },
        PROMPT
      )
    ).toBe(false)
  })

  it('rejects a completed reply belonging to another user message', () => {
    expect(
      hasCompletedProviderNativeTurn(
        {
          status: 'COMPLETED',
          subtasks: [...oldTurn, user, { ...assistant, status: 'COMPLETED', parent_id: 1 }],
        },
        PROMPT
      )
    ).toBe(false)
  })

  it('accepts the matching completed reply only after the task also settles', () => {
    const subtasks = [...oldTurn, user, { ...assistant, status: 'COMPLETED' }]
    expect(hasCompletedProviderNativeTurn({ status: 'RUNNING', subtasks }, PROMPT)).toBe(false)
    expect(hasCompletedProviderNativeTurn({ status: 'COMPLETED', subtasks }, PROMPT)).toBe(true)
  })

  it.each([null, {}, { status: 'COMPLETED', subtasks: null }])(
    'rejects incomplete task data: %j',
    task => expect(hasCompletedProviderNativeTurn(task, PROMPT)).toBe(false)
  )

  it('requires an actual message identity for the matching prompt', () => {
    expect(
      hasCompletedProviderNativeTurn(
        {
          status: 'COMPLETED',
          subtasks: [
            { role: 'USER', prompt: PROMPT, status: 'COMPLETED' },
            { role: 'ASSISTANT', status: 'COMPLETED' },
          ],
        },
        PROMPT
      )
    ).toBe(false)
  })
})
