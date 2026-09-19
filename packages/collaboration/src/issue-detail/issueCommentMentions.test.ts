import { describe, expect, it } from 'vitest'
import {
  filterIssueMentionOptions,
  findIssueMentionQuery,
  insertIssueMentionText,
  issueMentionPayload,
  pruneIssueMentionSelections,
  type IssueMentionOption,
} from './issueCommentMentions'

const alice: IssueMentionOption = { type: 'user', id: '7', label: 'alice' }
const bob: IssueMentionOption = { type: 'user', id: '8', label: 'bob' }
const reviewer: IssueMentionOption = {
  type: 'agent',
  id: '12',
  label: 'Code Reviewer',
}

describe('findIssueMentionQuery', () => {
  it('returns the active query ending at the caret', () => {
    expect(findIssueMentionQuery('ping @bo', 8)).toEqual({
      start: 5,
      query: 'bo',
    })
  })

  it('returns an empty query right after the trigger', () => {
    expect(findIssueMentionQuery('ping @', 6)).toEqual({ start: 5, query: '' })
  })

  it('ignores text that cannot extend a mention', () => {
    expect(findIssueMentionQuery('thank @bob later', 17)).toBeNull()
    expect(findIssueMentionQuery('no trigger here', 15)).toBeNull()
    expect(findIssueMentionQuery('@bob\nnext', 8)).toBeNull()
  })
})

describe('filterIssueMentionOptions', () => {
  it('matches case-insensitively and skips already selected targets', () => {
    expect(filterIssueMentionOptions([alice, bob, reviewer], 'B', [alice])).toEqual([bob])
  })

  it('returns every eligible option for an empty query', () => {
    expect(filterIssueMentionOptions([alice, reviewer], '')).toEqual([alice, reviewer])
  })
})

describe('insertIssueMentionText', () => {
  it('replaces the query, pads the mention and reports the selection', () => {
    const inserted = insertIssueMentionText('ping @bo', { start: 5, query: 'bo' }, bob, 8)
    expect(inserted.value).toBe('ping @bob ')
    expect(inserted.cursor).toBe(10)
    expect(inserted.selection).toEqual({ mention: bob, start: 5 })
  })

  it('adds a space when the caret sits directly next to existing text', () => {
    const inserted = insertIssueMentionText('@', { start: 0, query: '' }, alice, 1)
    expect(inserted.value).toBe('@alice ')
  })
})

describe('pruneIssueMentionSelections', () => {
  it('drops selections whose mention text was deleted', () => {
    expect(
      pruneIssueMentionSelections('@alice please review', [
        { mention: alice, start: 0 },
        { mention: bob, start: 0 },
      ])
    ).toEqual([{ mention: alice, start: 0 }])
  })
})

describe('issueMentionPayload', () => {
  it('de-duplicates repeated mentions and keeps insertion order', () => {
    expect(
      issueMentionPayload([
        { mention: alice, start: 0 },
        { mention: bob, start: 7 },
        { mention: alice, start: 12 },
      ])
    ).toEqual([
      { type: 'user', id: '7', label: 'alice' },
      { type: 'user', id: '8', label: 'bob' },
    ])
  })
})
