// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'

import {
  listKnowledgeSourceViews,
  registerKnowledgeSourceView,
} from '@/features/knowledge/knowledgeSourceViewRegistry'

describe('knowledgeSourceViewRegistry', () => {
  it('returns a copy of the registered view snapshot', () => {
    registerKnowledgeSourceView('immutable-test', {
      id: 'immutable-test',
      label: 'Immutable Test',
      renderView: () => null,
    })

    const listedViews = listKnowledgeSourceViews()
    listedViews.length = 0

    expect(listKnowledgeSourceViews()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'immutable-test' })])
    )
  })
})
