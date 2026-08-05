// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@/apis/client'
import {
  getReferencedBotNames,
  getReferencedKnowledgeBaseNames,
} from '@/features/resource-library/capabilityReferenceErrors'

describe('getReferencedBotNames', () => {
  test('returns affected agent names from an in-use reference error', () => {
    const error = new ApiError('Cannot unbind capability', 409, 'CAPABILITY_REFERENCE_IN_USE', {
      referenced_bots: [{ name: '智能体 A' }, { name: '智能体 B' }],
    })

    expect(getReferencedBotNames(error)).toEqual(['智能体 A', '智能体 B'])
  })

  test('ignores unrelated and malformed errors', () => {
    expect(getReferencedBotNames(new Error('failed'))).toEqual([])
    expect(
      getReferencedBotNames(
        new ApiError('Cannot unbind capability', 409, 'CAPABILITY_REFERENCE_IN_USE', {
          referenced_bots: [{ name: '' }, { name: 123 }],
        })
      )
    ).toEqual([])
  })
})

describe('getReferencedKnowledgeBaseNames', () => {
  test('returns affected knowledge base names from an in-use reference error', () => {
    const error = new ApiError('Cannot unbind capability', 409, 'CAPABILITY_REFERENCE_IN_USE', {
      referenced_knowledge_bases: [{ name: '知识库 A' }, { name: '知识库 B' }],
    })

    expect(getReferencedKnowledgeBaseNames(error)).toEqual(['知识库 A', '知识库 B'])
  })

  test('does not treat bot references as knowledge base references', () => {
    const error = new ApiError('Cannot unbind capability', 409, 'CAPABILITY_REFERENCE_IN_USE', {
      referenced_bots: [{ name: '智能体 A' }],
    })

    expect(getReferencedKnowledgeBaseNames(error)).toEqual([])
  })
})
