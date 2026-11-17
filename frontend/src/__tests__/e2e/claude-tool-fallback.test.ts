/** @jest-environment node */

import { withClaudeToolFallback } from '../../../e2e/utils/claude-tool-fallback'

const conversation = [
  { role: 'user', content: 'Original seed' },
  { role: 'assistant', content: [{ type: 'text', text: 'Seed remembered' }] },
  { role: 'user', content: 'Finish the follow-up' },
]
const notice =
  'ToolSearch is no longer available. Tools listed earlier as deferred that are still available are declared in full: call them directly.'
const reminder =
  "The date has changed. Today's date is now 2026-11-17. No need to announce the new date — the user's own clock shows it."

it('preserves the complete conversation when no system reminder is present', () => {
  expect(withClaudeToolFallback(conversation)).toEqual([
    ...conversation,
    {
      role: 'system',
      content: [{ type: 'text', text: notice, cache_control: { type: 'ephemeral' } }],
    },
  ])
})

it('preserves the midnight reminder and follow-up while appending the exact fallback notice', () => {
  const before = [
    ...conversation,
    {
      role: 'system',
      content: [{ type: 'text', text: reminder, cache_control: { type: 'ephemeral' } }],
    },
  ]
  const snapshot = JSON.stringify(before)
  expect(withClaudeToolFallback(before)).toEqual([
    ...conversation,
    {
      role: 'system',
      content: [
        { type: 'text', text: `${reminder}\n\n${notice}`, cache_control: { type: 'ephemeral' } },
      ],
    },
  ])
  expect(JSON.stringify(before)).toBe(snapshot)
})

it.each([
  { label: 'string', content: 'unexpected text' },
  { label: 'empty', content: [] },
  { label: 'non-text', content: [{ type: 'image', text: 'Unexpected block' }] },
  { label: 'non-string', content: [{ type: 'text', text: 42 }] },
  { label: 'multiple blocks', content: [{ text: 'a' }, { text: 'b' }] },
])('rejects $label system content instead of discarding it', ({ content }) => {
  expect(() => withClaudeToolFallback([...conversation, { role: 'system', content }])).toThrow(
    'Unexpected Claude Code trailing system message structure'
  )
})
