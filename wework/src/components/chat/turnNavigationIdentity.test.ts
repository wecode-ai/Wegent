import { describe, expect, it } from 'vitest'
import {
  buildUserTurnsForNavigation,
  findLoadedNavigationMessageId,
  getTurnVisibilityBounds,
} from '../../../../packages/collaboration/src/conversation/turnNavigationUtils'

describe('paginated turn navigation identity', () => {
  const navigation = Array.from({ length: 25 }, (_, index) => ({
    id: `turn-${index}`,
    turnId: `turn-${index}`,
    turnIndex: index,
    messageIndex: index,
    promptPreview: `Request ${index}`,
    cursor: `cursor-${index}`,
  }))
  const messages = [
    { id: 'user-24', turnId: 'turn-24', role: 'user', content: 'Request 24' },
    { id: 'reply-24', turnId: 'turn-24', role: 'assistant', content: 'Latest reply' },
  ]

  it('does not bind the first historical turn to the first message of the loaded page', () => {
    const turns = buildUserTurnsForNavigation(messages, navigation)
    expect(turns).toHaveLength(25)
    expect(turns[0]).toMatchObject({ id: 'turn-0', loaded: false, promptPreview: 'Request 0' })
    expect(turns[24]).toMatchObject({ id: 'user-24', loaded: true, turnIndex: 24 })
    expect(new Set(turns.map(turn => turn.id)).size).toBe(25)
  })

  it('associates a visible reply with its owning turn when page indexes restart at zero', () => {
    const turns = buildUserTurnsForNavigation(messages, navigation)
    const scroller = document.createElement('div')
    const reply = document.createElement('div')
    const bounds = getTurnVisibilityBounds(
      turns,
      messages,
      new Map([['reply-24', reply]]),
      scroller
    )
    expect([...bounds.keys()]).toEqual(['user-24'])
  })

  it('does not resolve an unloaded turn through a colliding message index', () => {
    expect(
      findLoadedNavigationMessageId([{ ...messages[0], runtimeMessageIndex: 0 }], {
        navigationId: 'turn-0',
        turnId: 'turn-0',
        messageIndex: 0,
      })
    ).toBeNull()
  })

  it('keeps guidance next to its owning turn without replacing the original request', () => {
    const loaded = [
      ...messages,
      { id: 'guidance-24', turnId: 'turn-24', role: 'user', content: 'Continue' },
      { id: 'continued-24', turnId: 'turn-24', role: 'assistant', content: 'Continued reply' },
    ]
    const turns = buildUserTurnsForNavigation(loaded, navigation)
    expect(turns).toHaveLength(26)
    expect(turns.slice(-2).map(turn => turn.id)).toEqual(['user-24', 'guidance-24'])
    const reply = document.createElement('div')
    const bounds = getTurnVisibilityBounds(
      turns,
      loaded,
      new Map([['reply-24', reply]]),
      document.createElement('div')
    )
    expect([...bounds.keys()]).toEqual(['user-24'])
  })

  it('uses the canonical turn when the loaded page contains only assistant items', () => {
    const reply = document.createElement('div')
    const loaded = [messages[1]]
    const turns = buildUserTurnsForNavigation(loaded, navigation)
    const bounds = getTurnVisibilityBounds(
      turns,
      loaded,
      new Map([['reply-24', reply]]),
      document.createElement('div')
    )
    expect([...bounds.keys()]).toEqual(['turn-24'])
  })
})
