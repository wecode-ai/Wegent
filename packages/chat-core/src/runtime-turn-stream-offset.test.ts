import { expect, it } from 'vitest'
import { upsertAssistantText } from './runtime-turn-updates'

it('uses executor Unicode scalar offsets without splitting astral characters or duplicating replay', () => {
  const initial = upsertAssistantText([], 'text', '你🙂', 'delta', 0)
  const replay = upsertAssistantText(initial, 'text', '🙂', 'delta', 1)
  const appended = upsertAssistantText(replay, 'text', '！', 'delta', 2)
  expect(appended[0]).toMatchObject({ content: '你🙂！', streamTextOffset: 3 })
})
