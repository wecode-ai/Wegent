// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import BindKnowledgeBaseDialog from '@/features/tasks/components/group-chat/BindKnowledgeBaseDialog'

const mockListKnowledgeBases = jest.fn()
const mockBindKnowledgeBase = jest.fn()

const mockT = (key: string, _params?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    'groupChat.knowledge.addTitle': 'Add Knowledge',
    'groupChat.knowledge.addDescription': 'Choose a knowledge source',
    'knowledgeBinding.internalKnowledge': 'Internal',
    'knowledgeBinding.externalKnowledge': 'External',
    'groupChat.knowledge.add': 'Add',
    'groupChat.knowledge.noAvailable': 'No available knowledge bases',
    'knowledge:search_placeholder': 'Search',
    'knowledge:fetch_error': 'Failed to fetch',
    'knowledgeBinding.externalLoadFailed': 'External load failed',
    'knowledgeBinding.noAvailableExternal': 'No available external sources',
    'groupChat.knowledge.bindSuccess': 'Bound',
    'groupChat.knowledge.bindFailed': 'Failed to bind',
    'common:actions.cancel': 'Cancel',
    'common:branches.no_match': 'No match',
  }
  return map[key] ?? key
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    list: (...args: unknown[]) => mockListKnowledgeBases(...args),
  },
}))

jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: {
    bindKnowledgeBase: (...args: unknown[]) => mockBindKnowledgeBase(...args),
    bindExternalKnowledgeRefs: jest.fn(),
  },
}))

jest.mock('@/features/knowledge/document/extension-loader', () => ({
  loadKBExtensions: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => [],
  getExternalKnowledgeSource: jest.fn(),
  registerExternalKnowledgeSource: jest.fn(),
}))

jest.mock('@/lib/i18n-helpers', () => ({
  formatDocumentCount: (count: number) => `${count} docs`,
}))

const kbA = {
  id: 1,
  name: 'kb-a',
  namespace: 'default',
  display_name: 'KB A',
  document_count: 3,
}

const kbB = {
  id: 2,
  name: 'kb-b',
  namespace: 'default',
  display_name: 'KB B',
  document_count: 5,
}

const renderDialog = (
  props: Partial<React.ComponentProps<typeof BindKnowledgeBaseDialog>> = {}
) => {
  const defaultProps: React.ComponentProps<typeof BindKnowledgeBaseDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    taskId: 71,
    boundKnowledgeBases: [],
    boundExternalRefs: [],
    onSuccess: jest.fn(),
  }
  return render(<BindKnowledgeBaseDialog {...defaultProps} {...props} />)
}

describe('BindKnowledgeBaseDialog', () => {
  beforeEach(() => {
    mockListKnowledgeBases.mockReset()
    mockBindKnowledgeBase.mockReset()
  })

  it('excludes already bound internal knowledge bases by stable id', async () => {
    mockListKnowledgeBases.mockResolvedValue({ items: [kbA, kbB] })

    renderDialog({
      boundKnowledgeBases: [{ ...kbA, display_name: 'KB A', bound_by: 'u', bound_at: '' }],
    })

    await waitFor(() => {
      expect(screen.queryByText('kb-a')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('kb-b')).toBeInTheDocument()
  })

  it('does not exclude knowledge bases with the same name but different id', async () => {
    mockListKnowledgeBases.mockResolvedValue({
      items: [
        { ...kbA, id: 99, name: 'same-name' },
        { ...kbB, id: 2, name: 'same-name' },
      ],
    })

    renderDialog({
      boundKnowledgeBases: [
        {
          id: 99,
          name: 'same-name',
          namespace: 'default',
          display_name: 'Same',
          bound_by: 'u',
          bound_at: '',
          document_count: 1,
        },
      ],
    })

    await waitFor(() => {
      expect(screen.getAllByText('same-name')).toHaveLength(1)
    })
  })

  it('binds the selected knowledge base by name and namespace', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    mockListKnowledgeBases.mockResolvedValue({ items: [kbA] })
    mockBindKnowledgeBase.mockResolvedValue({
      id: 1,
      name: 'kb-a',
      namespace: 'default',
      display_name: 'KB A',
      document_count: 3,
      bound_by: 'u',
      bound_at: '',
    })

    renderDialog()

    await waitFor(() => expect(screen.getByText('kb-a')).toBeInTheDocument())
    await user.click(screen.getByText('kb-a'))
    await user.click(screen.getByText('Add'))

    await waitFor(() => {
      expect(mockBindKnowledgeBase).toHaveBeenCalledWith(71, 'kb-a', 'default')
    })
  })
})
