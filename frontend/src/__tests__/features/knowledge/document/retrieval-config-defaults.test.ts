// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_SCORE_THRESHOLD,
  createDefaultRetrievalConfig,
  createDefaultRetrievalProfile,
} from '@/features/knowledge/document/components/retrievalConfig'

describe('retrieval config defaults', () => {
  test('an unconfigured score threshold prefills "do not cut"', () => {
    expect(DEFAULT_SCORE_THRESHOLD).toBe(0)
    expect(createDefaultRetrievalConfig().score_threshold).toBe(DEFAULT_SCORE_THRESHOLD)
    expect(createDefaultRetrievalProfile().score_threshold).toBe(DEFAULT_SCORE_THRESHOLD)
  })
})
