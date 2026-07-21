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
  if (key === 'knowledgeBinding.selectedExternalTargets')
    return `${params?.count ?? 0} selected targets`
  if (key === 'knowledgeBinding.title') return 'Knowledge Sources'
  if (key === 'knowledgeBinding.empty') return 'No knowledge sources bound'
  if (key === 'knowledgeBinding.loadFailed') return 'Failed to load knowledge sources'
  if (key === 'knowledgeBinding.externalLoadFailed')
    return 'External knowledge sources could not be loaded. Internal knowledge bases remain available.'
  if (key === 'knowledgeBinding.remove') return `Remove ${params?.name ?? ''}`
  if (key === 'knowledgeBinding.removeSuccess') return `Removed ${params?.name ?? ''}`
  if (key === 'knowledgeBinding.removeFailed') return 'Failed to remove knowledge source'
  if (key === 'knowledgeBinding.warningUnsupportedBinding')
    return 'Whole source already covers this child target'
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
  registerExternalKnowledgeSource: jest.fn(),
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

  it('keeps the binding list as the scrollable region', async () => {
    render(<TaskKnowledgeBindingPanel taskId={71} onClose={jest.fn()} />)

    const list = await screen.findByTestId('task-knowledge-binding-list')

    expect(list).toHaveClass('min-h-0')
    expect(list).toHaveClass('flex-1')
    expect(list).toHaveClass('overflow-y-auto')
    expect(screen.getByRole('button', { name: 'Done' }).parentElement).toHaveClass('shrink-0')
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
      expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'test-mcp', 'default', 1)
    })
    await waitFor(() => {
      expect(screen.queryByText('测试mcp')).not.toBeInTheDocument()
    })
  })

  it('removes an external knowledge binding through the external refs API', async () => {
    render(<TaskKnowledgeBindingPanel taskId={71} />)

    await screen.findByText('测试1111')
    fireEvent.click(screen.getByTestId('task-knowledge-binding-remove-external:ap:explicit:lib-1'))

    await waitFor(() => {
      expect(mockRemoveExternalKnowledgeRef).toHaveBeenCalledWith(71, externalRef)
    })
    await waitFor(() => {
      expect(screen.queryByText('测试1111')).not.toBeInTheDocument()
    })
  })

  it('groups external document bindings and removes every ref in the group', async () => {
    const documentRefs = [
      {
        provider: 'ap',
        mode: 'explicit',
        id: 'lib-1',
        name: '测试1111',
        scope: 'organization',
        target_type: 'document' as const,
        node_id: 'node-1',
        document_id: 'doc-1',
        target_name: 'A.md',
      },
      {
        provider: 'ap',
        mode: 'explicit',
        id: 'lib-1',
        name: '测试1111',
        scope: 'organization',
        target_type: 'document' as const,
        node_id: 'node-2',
        document_id: 'doc-2',
        target_name: 'B.md',
      },
    ]
    mockGetBoundExternalKnowledgeRefs.mockResolvedValue({
      items: documentRefs,
      total: 2,
    })
    mockRemoveExternalKnowledgeRef
      .mockResolvedValueOnce({ message: 'ok', items: [documentRefs[1]], total: 1 })
      .mockResolvedValueOnce({ message: 'ok', items: [], total: 0 })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    await screen.findByText('测试1111')
    expect(screen.getByText('2 selected targets')).toBeInTheDocument()
    expect(screen.queryByText('B.md')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-knowledge-binding-remove-external:ap:explicit:lib-1'))

    await waitFor(() => {
      expect(mockRemoveExternalKnowledgeRef).toHaveBeenCalledTimes(2)
      expect(mockRemoveExternalKnowledgeRef).toHaveBeenNthCalledWith(1, 71, documentRefs[0])
      expect(mockRemoveExternalKnowledgeRef).toHaveBeenNthCalledWith(2, 71, documentRefs[1])
    })
    await waitFor(() => {
      expect(screen.queryByText('测试1111')).not.toBeInTheDocument()
    })
  })

  it('exposes full long source and target names for grouped external bindings', async () => {
    const sourceName = 'AP 企业知识库 2026 年度跨部门集成联调与权限验收说明资料全集'
    const targetName = '项目资料 / 需求说明 / 2026 年度权限验收说明最终版.docx'
    mockGetBoundExternalKnowledgeRefs.mockResolvedValue({
      items: [
        {
          provider: 'ap',
          mode: 'explicit',
          id: 'lib-1',
          name: sourceName,
          scope: 'organization',
          target_type: 'document' as const,
          node_id: 'node-1',
          document_id: 'doc-1',
          target_name: targetName,
        },
      ],
      total: 1,
    })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    const externalRow = await screen.findByTestId(
      'task-knowledge-binding-external:ap:explicit:lib-1'
    )
    expect(externalRow).not.toHaveAttribute('title')
    expect(externalRow).toHaveAttribute('aria-label', `${sourceName} / ${targetName}`)
    expect(screen.getByText(sourceName)).toHaveClass('truncate')
    expect(screen.queryByText(targetName)).not.toBeInTheDocument()
    expect(
      screen.getByTestId('task-knowledge-binding-remove-external:ap:explicit:lib-1')
    ).toHaveClass('shrink-0')
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
        expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'test-mcp', 'default', 1)
      })
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('renders and unbinds a scope-only internal knowledge binding by stable ID', async () => {
    mockGetBoundKnowledgeBases.mockResolvedValue({
      items: [
        {
          ...internalKnowledgeBase,
          id: 2,
          name: 'scoped-only',
          display_name: 'Scoped only',
          scope_restricted: true,
          document_ids: [11],
        },
      ],
      total: 1,
      max_limit: 10,
    })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Scoped only' }))
    await waitFor(() => {
      expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'scoped-only', 'default', 2)
    })
  })

  it('shows a clear whole-versus-child conflict warning', async () => {
    mockGetBoundExternalKnowledgeRefs.mockResolvedValue({
      items: [externalRef],
      total: 1,
      context_warnings: [
        {
          type: 'external_knowledge',
          reason: 'unsupported_binding',
          id: 'lib-1',
          name: 'Child document',
          message: 'generic backend text',
        },
      ],
    })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    expect(await screen.findByText(/Whole source already covers this child target/)).toBeVisible()
  })

  it('filters local state by kb.id when unbinding, not name+namespace', async () => {
    mockGetBoundKnowledgeBases.mockResolvedValue({
      items: [
        { ...internalKnowledgeBase, id: 1, name: 'same-name', display_name: 'First KB' },
        { ...internalKnowledgeBase, id: 2, name: 'same-name', display_name: 'Second KB' },
      ],
      total: 2,
      max_limit: 10,
    })
    mockUnbindKnowledgeBase.mockResolvedValue({
      message: 'ok',
      kb_name: 'same-name',
      kb_namespace: 'default',
    })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    expect(await screen.findByText('First KB')).toBeInTheDocument()
    expect(screen.getByText('Second KB')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove First KB' }))

    await waitFor(() => {
      expect(mockUnbindKnowledgeBase).toHaveBeenCalledWith(71, 'same-name', 'default', 1)
    })
    await waitFor(() => {
      expect(screen.queryByText('First KB')).not.toBeInTheDocument()
      expect(screen.getByText('Second KB')).toBeInTheDocument()
    })
  })

  it('falls back to name+namespace filter when id is missing', async () => {
    mockGetBoundKnowledgeBases.mockResolvedValue({
      items: [
        {
          ...internalKnowledgeBase,
          id: undefined as unknown as number,
          name: 'legacy',
          display_name: 'Legacy KB',
        },
      ],
      total: 1,
      max_limit: 10,
    })
    mockUnbindKnowledgeBase.mockResolvedValue({
      message: 'ok',
      kb_name: 'legacy',
      kb_namespace: 'default',
    })

    render(<TaskKnowledgeBindingPanel taskId={71} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Legacy KB' }))

    await waitFor(() => {
      expect(screen.queryByText('Legacy KB')).not.toBeInTheDocument()
    })
  })
})
