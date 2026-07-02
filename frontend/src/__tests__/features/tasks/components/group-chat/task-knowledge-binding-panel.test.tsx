// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import TaskKnowledgeBindingPanel from '@/features/tasks/components/group-chat/task-knowledge-binding-panel'

const mockGetBoundKnowledgeBases = jest.fn()
const mockGetBoundExternalKnowledgeRefs = jest.fn()
const mockUnbindKnowledgeBase = jest.fn()
const mockRemoveExternalKnowledgeRef = jest.fn()
const mockToast = jest.fn()

const mockT = (key: string, params?: Record<string, unknown>) => {
  if (key === 'knowledgeBinding.count') return `${params?.count ?? 0} bound`
  if (key === 'knowledgeBinding.externalKnowledge') return 'External knowledge source'
  if (key === 'knowledgeBinding.title') return 'Knowledge Sources'
  if (key === 'knowledgeBinding.empty') return 'No knowledge sources bound'
  if (key === 'knowledgeBinding.loadFailed') return 'Failed to load knowledge sources'
  if (key === 'knowledgeBinding.externalLoadFailed')
    return 'External knowledge sources could not be loaded. Internal knowledge bases remain available.'
  if (key === 'knowledgeBinding.remove') return `Remove ${params?.name ?? ''}`
  if (key === 'knowledgeBinding.removeSuccess') return `Removed ${params?.name ?? ''}`
  if (key === 'knowledgeBinding.removeFailed') return 'Failed to remove knowledge source'
  if (key === 'groupChat.knowledge.add') return 'Add'
  if (key === 'groupChat.knowledge.boundBy') return `Bound by ${params?.name ?? ''}`
  if (key === 'common:actions.done') return 'Done'
  return key
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  getExternalKnowledgeSource: jest.fn(() => ({ shortLabel: 'AP' })),
}))

jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: {
    getBoundKnowledgeBases: (...args: unknown[]) => mockGetBoundKnowledgeBases(...args),
    getBoundExternalKnowledgeRefs: (...args: unknown[]) =>
      mockGetBoundExternalKnowledgeRefs(...args),
    unbindKnowledgeBase: (...args: unknown[]) => mockUnbindKnowledgeBase(...args),
    removeExternalKnowledgeRef: (...args: unknown[]) => mockRemoveExternalKnowledgeRef(...args),
  },
}))

jest.mock('@/features/tasks/components/group-chat/BindKnowledgeBaseDialog', () => {
  const MockBindKnowledgeBaseDialog = () => null
  MockBindKnowledgeBaseDialog.displayName = 'MockBindKnowledgeBaseDialog'
  return MockBindKnowledgeBaseDialog
})

const internalKnowledgeBase = {
  id: 1,
  name: 'test-mcp',
  namespace: 'default',
  display_name: '测试mcp',
  description: 'Internal KB',
  document_count: 3,
  bound_by: 'alice',
  bound_at: '2026-06-26T00:00:00Z',
}

const externalRef = {
  provider: 'ap',
  mode: 'explicit',
  id: 'lib-1',
  name: '测试1111',
  scope: 'organization',
  target_type: 'knowledge_base' as const,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetBoundKnowledgeBases.mockResolvedValue({
    items: [internalKnowledgeBase],
    total: 1,
    max_limit: 10,
  })
  mockGetBoundExternalKnowledgeRefs.mockResolvedValue({
    items: [externalRef],
    total: 1,
  })
  mockUnbindKnowledgeBase.mockResolvedValue({
    message: 'ok',
    kb_name: 'test-mcp',
    kb_namespace: 'default',
  })
  mockRemoveExternalKnowledgeRef.mockResolvedValue({
    message: 'ok',
    items: [],
    total: 0,
  })
})

describe('TaskKnowledgeBindingPanel', () => {
  it('renders internal and external task-level knowledge bindings in one list', async () => {
    render(<TaskKnowledgeBindingPanel taskId={71} />)

    await waitFor(() => {
      expect(mockGetBoundKnowledgeBases).toHaveBeenCalledWith(71)
      expect(mockGetBoundExternalKnowledgeRefs).toHaveBeenCalledWith(71)
    })

    expect(await screen.findByText('测试mcp')).toBeInTheDocument()
    expect(screen.getByText('测试1111')).toBeInTheDocument()
    expect(screen.getByText('AP')).toBeInTheDocument()
    expect(screen.getByText('External knowledge source')).toBeInTheDocument()
  })

  it('removes an internal knowledge binding through the existing task KB API', async () => {
    render(<TaskKnowledgeBindingPanel taskId={71} />)

    await screen.findByText('测试mcp')
    const removeButton = screen.getByRole('button', { name: 'Remove 测试mcp' })
    expect(removeButton).toHaveAttribute(
      'data-testid',
      'task-knowledge-binding-remove-internal:1:test-mcp:default'
    )
    fireEvent.click(removeButton)

    await waitFor(() => {
      expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'test-mcp', 'default')
    })
    await waitFor(() => {
      expect(screen.queryByText('测试mcp')).not.toBeInTheDocument()
    })
  })

  it('removes an external knowledge binding through the external refs API', async () => {
    render(<TaskKnowledgeBindingPanel taskId={71} />)

    await screen.findByText('测试1111')
    fireEvent.click(
      screen.getByTestId(
        'task-knowledge-binding-remove-external:ap:explicit:lib-1:knowledge_base:source'
      )
    )

    await waitFor(() => {
      expect(mockRemoveExternalKnowledgeRef).toHaveBeenCalledWith(71, externalRef)
    })
    await waitFor(() => {
      expect(screen.queryByText('测试1111')).not.toBeInTheDocument()
    })
  })

  it('keeps internal knowledge management available when external bindings fail to load', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockGetBoundExternalKnowledgeRefs.mockRejectedValue(new Error('external route unavailable'))

    try {
      render(<TaskKnowledgeBindingPanel taskId={71} />)

      expect(await screen.findByText('测试mcp')).toBeInTheDocument()
      expect(
        screen.getByText(
          'External knowledge sources could not be loaded. Internal knowledge bases remain available.'
        )
      ).toBeInTheDocument()
      expect(screen.queryByText('测试1111')).not.toBeInTheDocument()
      expect(consoleWarn).toHaveBeenCalledWith(
        'Failed to fetch external task knowledge bindings:',
        expect.any(Error)
      )

      fireEvent.click(screen.getByRole('button', { name: 'Remove 测试mcp' }))
      await waitFor(() => {
        expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'test-mcp', 'default')
      })
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
