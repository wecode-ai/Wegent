// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatRetrieverStorageExt, parseRetrieverStorageExt } from '@/utils/retriever-ext'

describe('retriever-ext utils', () => {
  it('returns undefined for empty extension JSON', () => {
    expect(parseRetrieverStorageExt('')).toBeUndefined()
    expect(parseRetrieverStorageExt('   ')).toBeUndefined()
  })

  it('parses valid JSON objects', () => {
    expect(parseRetrieverStorageExt('{"hybrid_ranker":"WeightedRanker"}')).toEqual({
      hybrid_ranker: 'WeightedRanker',
    })
  })

  it('rejects non-object JSON values', () => {
    expect(() => parseRetrieverStorageExt('[]')).toThrow(
      'Retriever storage extension JSON must be an object'
    )
    expect(() => parseRetrieverStorageExt('"text"')).toThrow(
      'Retriever storage extension JSON must be an object'
    )
  })

  it('formats extension JSON with indentation', () => {
    expect(formatRetrieverStorageExt({ hybrid_ranker: 'WeightedRanker' })).toBe(
      '{\n  "hybrid_ranker": "WeightedRanker"\n}'
    )
  })

  it('returns empty string for missing or empty ext config', () => {
    expect(formatRetrieverStorageExt()).toBe('')
    expect(formatRetrieverStorageExt({})).toBe('')
  })
})
