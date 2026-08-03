// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { getExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import ContextBadge from '@/features/tasks/components/chat/ContextBadge'
import type { ContextItem } from '@/types/context'

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  getExternalKnowledgeSource: jest.fn(() => ({ shortLabel: 'Demo' })),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('ContextBadge', () => {
  it('resolves an external knowledge source label from the registry', () => {
    const context: ContextItem = {
      type: 'external_knowledge',
      id: 'external:demo-provider:explicit:kb-1',
      name: 'Demo Knowledge Base',
      ref: {
        provider: 'demo-provider',
        mode: 'explicit',
        id: 'kb-1',
        name: 'Demo Knowledge Base',
      },
    }

    render(<ContextBadge context={context} onRemove={jest.fn()} />)

    expect(getExternalKnowledgeSource).toHaveBeenCalledWith('demo-provider')
    expect(screen.getByLabelText('Demo · Demo Knowledge Base')).toBeInTheDocument()
  })
})
