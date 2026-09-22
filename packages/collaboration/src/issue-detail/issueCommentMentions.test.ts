import { describe, expect, it } from 'vitest'
import {
  insertIssueMention,
  issueMentionPayload,
  sameIssueMention,
  type IssueMentionOption,
} from './issueCommentMentions'

const alice: IssueMentionOption = { type: 'user', id: '7', label: 'alice' }
const bob: IssueMentionOption = { type: 'user', id: '8', label: 'bob' }

describe('insertIssueMention', () => {
  it('replaces the trigger with the mention and reports the caret after it', () => {
    expect(insertIssueMention('ping @', 6, 6, 'bob')).toEqual({
      value: 'ping @bob ',
      caret: 10,
    })
  })

  it('pads a mention that lands directly against the text it follows', () => {
    expect(insertIssueMention('hi@', 3, 3, 'alice')).toEqual({
      value: 'hi @alice ',
      caret: 10,
    })
  })

  it('keeps the text after the caret and does not pad before a space', () => {
    expect(insertIssueMention('@ please look', 0, 1, 'alice')).toEqual({
      value: '@alice please look',
      caret: 6,
    })
  })
})

describe('issueMentionPayload', () => {
  it('drops picks whose mention text the draft lost', () => {
    expect(issueMentionPayload('@alice please review', [alice, bob])).toEqual([
      { type: 'user', id: '7', label: 'alice' },
    ])
  })

  it('de-duplicates a target picked twice and keeps insertion order', () => {
    expect(issueMentionPayload('@alice and @bob and @alice', [alice, bob, alice])).toEqual([
      { type: 'user', id: '7', label: 'alice' },
      { type: 'user', id: '8', label: 'bob' },
    ])
  })
})

describe('sameIssueMention', () => {
  it('treats one member as one target regardless of the label', () => {
    expect(sameIssueMention(alice, { ...alice, label: 'Alice' })).toBe(true)
    expect(sameIssueMention(alice, bob)).toBe(false)
  })
})
