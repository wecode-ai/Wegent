// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createDefaultRetrievalConfig,
  createDefaultRetrievalProfile,
} from '@/features/knowledge/document/components/retrievalConfig'

describe('retrieval config defaults', () => {
  test('an unconfigured score threshold prefills the frontend baseline', () => {
    expect(createDefaultRetrievalConfig().score_threshold).toBe(0.5)
    expect(createDefaultRetrievalProfile().score_threshold).toBe(0.5)
  })
})
