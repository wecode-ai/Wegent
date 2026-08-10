// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { KnowledgeBaseMultiSelector } from '@/features/settings/components/knowledge/KnowledgeBaseMultiSelector'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback || key,
  }),
}))

jest.mock('@/features/settings/hooks/useKnowledgeBaseOptions', () => ({
  useKnowledgeBaseOptions: () => ({
    options: [],
    loading: false,
    error: null,
  }),
}))

describe('KnowledgeBaseMultiSelector long selected labels', () => {
  it('keeps selected default knowledge names bounded with full-name metadata', () => {
    const knowledgeBaseName = '内部知识库 2026 年度跨部门集成联调与权限验收说明资料全集'

    render(
      <KnowledgeBaseMultiSelector
        value={[{ id: 42, name: knowledgeBaseName }]}
        onChange={jest.fn()}
      />
    )

    const chip = screen.getByTestId('default-knowledge-base-chip-42')
    expect(chip).not.toHaveAttribute('title')
    expect(chip).toHaveAttribute('aria-label', knowledgeBaseName)
    expect(screen.getByText(knowledgeBaseName)).toHaveClass('truncate')
    expect(screen.getByTestId('default-knowledge-base-remove-42')).toHaveClass('shrink-0')
  })
})
