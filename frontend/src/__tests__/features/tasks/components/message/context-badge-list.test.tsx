// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { registerExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { ContextBadgeList } from '@/features/tasks/components/message/ContextBadgeList'
import type { SubtaskContextBrief } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/input/AttachmentPreview', () => ({
  __esModule: true,
  default: () => null,
}))

describe('ContextBadgeList', () => {
  it('exposes the registered external source without overriding the title tooltip', () => {
    registerExternalKnowledgeSource('fake-provider', {
      providerId: 'fake-provider',
      label: 'Fake Provider',
      shortLabel: 'Fake',
      listKnowledgeBases: jest.fn(),
    })
    const context: SubtaskContextBrief = {
      id: 1,
      context_type: 'external_knowledge',
      name: 'External KB',
      status: 'ready',
      external_provider: 'fake-provider',
      external_target_type: 'knowledge_base',
    }

    render(<ContextBadgeList contexts={[context]} />)

    const title = screen.getByTitle('External KB')
    const badge = title.parentElement?.parentElement
    expect(title).toHaveTextContent('Fake · External KB')
    expect(badge).not.toHaveAttribute('aria-label')
    expect(badge).not.toHaveAttribute('title')
  })
})
