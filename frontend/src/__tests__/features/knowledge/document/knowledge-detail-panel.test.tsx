// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { KnowledgeDetailPanel } from '@/features/knowledge/document/components/KnowledgeDetailPanel'
import type { KnowledgeBase } from '@/types/knowledge'
import type { ArtifactPromptRequest } from '@/types/knowledge-artifact'

const mockChatArea = jest.fn()
const mockSourcePanel = jest.fn()
const mockGenerationPanel = jest.fn()
const mockSelectTask = jest.fn()
const mockFetchPermission = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 7 } }),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({
    teams: [],
    isTeamsLoading: false,
    refreshTeams: jest.fn().mockResolvedValue([]),
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ selectTask: mockSelectTask }),
}))

jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({
    myPermission: { has_access: true, role: 'Developer', is_creator: false },
    fetchMyPermission: mockFetchPermission,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useNamespaceRoleMap', () => ({
  useNamespaceRoleMap: () => new Map(),
}))

jest.mock('@/utils/namespace-permissions', () => ({
  canManageKnowledgeBase: () => true,
  canManageKnowledgeBaseDocuments: () => true,
  canManageKnowledgeBasePermissions: () => true,
}))

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: (props: { selectedDocumentIds: number[] }) => {
    mockChatArea(props)
    return <div data-testid="mock-chat-area" />
  },
}))

jest.mock('@/features/knowledge/document/components/KnowledgeSourcePanel', () => ({
  KnowledgeSourcePanel: (props: {
    selectedDocumentIds: number[]
    mobileVisible: boolean
    onDocumentSelectionChange: (documentIds: number[]) => void
  }) => {
    mockSourcePanel(props)
    return (
      <button
        data-testid="mock-source-panel"
        onClick={() => props.onDocumentSelectionChange([11, 12])}
      />
    )
  },
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactWorkspacePanel', () => ({
  ArtifactWorkspacePanel: (props: {
    selectedDocumentIds: number[]
    mobileVisible: boolean
    onAskNode?: (request: ArtifactPromptRequest) => void
  }) => {
    mockGenerationPanel(props)
    return (
      <button
        data-testid="mock-generation-panel"
        onClick={() =>
          props.onAskNode?.({
            requestId: 'request-1',
            message: 'Explain this node',
            artifactContext: {
              artifact_id: 'artifact-1',
              node_id: 'node-1',
            },
          })
        }
      />
    )
  },
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: () => null,
}))

jest.mock('@/features/knowledge/document/components/KnowledgeBaseSummaryCard', () => ({
  KnowledgeBaseSummaryCard: () => null,
}))

jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: ({ headerActions }: { headerActions?: React.ReactNode }) => (
    <div data-testid="mock-classic-document-list">{headerActions}</div>
  ),
}))

jest.mock('@/features/knowledge/document/components/KnowledgeAccessDialog', () => ({
  KnowledgeAccessDialog: ({
    canManage,
    onChanged,
    onClose,
  }: {
    canManage: boolean
    onChanged: () => void
    onClose: () => void
  }) => (
    <div role="dialog">
      {canManage && (
        <button data-testid="mock-classic-permissions" onClick={onChanged}>
          Change permission
        </button>
      )}
      <button onClick={onClose}>Close permission dialog</button>
    </div>
  ),
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

const knowledgeBase: KnowledgeBase = {
  id: 12,
  name: 'workspace-kb',
  description: null,
  user_id: 7,
  namespace: 'default',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 0,
  created_at: '2026-07-28T00:00:00Z',
  updated_at: '2026-07-28T00:00:00Z',
}

describe('KnowledgeDetailPanel workspace', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shares one source scope across the source, chat, and generation columns', () => {
    render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)

    expect(screen.getByTestId('knowledge-detail-notebook')).toHaveClass(
      'border-t',
      'border-border',
      'lg:flex-row'
    )
    expect(screen.getByTestId('knowledge-workspace-chat')).toHaveClass('lg:flex')
    expect(screen.getByTestId('knowledge-mobile-sources-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('knowledge-mobile-chat-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('knowledge-mobile-generation-tab')).toHaveClass('h-11')
    expect(screen.getByTestId('mock-source-panel')).toBeInTheDocument()
    expect(screen.getByTestId('mock-chat-area')).toBeInTheDocument()
    expect(screen.getByTestId('mock-generation-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mock-source-panel'))

    expect(mockChatArea).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedDocumentIds: [11, 12] })
    )
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedDocumentIds: [11, 12] })
    )
  })

  it('switches among sources, chat, and generation below the three-column breakpoint', () => {
    render(<KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />)

    expect(mockSourcePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: false })
    )
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: false })
    )

    fireEvent.mouseDown(screen.getByTestId('knowledge-mobile-sources-tab'), { button: 0 })
    expect(mockSourcePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: true })
    )

    fireEvent.mouseDown(screen.getByTestId('knowledge-mobile-generation-tab'), { button: 0 })
    expect(mockGenerationPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ mobileVisible: true })
    )

    fireEvent.click(screen.getByTestId('mock-generation-panel'))
    expect(mockChatArea).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalPromptRequest: expect.objectContaining({ requestId: 'request-1' }),
      })
    )
  })
})

it('exits the classic permission view when the list confirms management downgrade', () => {
  const classic = { ...knowledgeBase, kb_type: 'classic' as const }
  const { rerender } = render(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Maintainer" />
  )
  const trigger = screen.getByTestId('knowledge-detail-permissions-tab')
  expect(trigger).toHaveClass('min-h-11', 'min-w-11')
  fireEvent.click(trigger)
  expect(screen.getByTestId('mock-classic-permissions')).toBeInTheDocument()
  const calls = mockFetchPermission.mock.calls.length
  rerender(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Reporter" />
  )
  expect(screen.queryByTestId('knowledge-detail-permissions-tab')).not.toBeInTheDocument()
  expect(screen.queryByTestId('mock-classic-permissions')).not.toBeInTheDocument()
  expect(mockFetchPermission.mock.calls.length).toBeGreaterThan(calls)
})

it('renders the current chat actions and clears them when switching libraries', () => {
  const action = jest.fn()
  const { rerender } = render(
    <KnowledgeDetailPanel selectedKb={knowledgeBase} currentView="notebook" />
  )
  const oldChat = mockChatArea.mock.calls.at(-1)![0]
  expect(oldChat.onShareButtonRender).toEqual(expect.any(Function))
  act(() => oldChat.onShareButtonRender(<button onClick={action}>Export current chat</button>))
  fireEvent.click(screen.getByRole('button', { name: 'Export current chat' }))
  expect(action).toHaveBeenCalledTimes(1)
  act(() => oldChat.onShareButtonRender(<button>Export next conversation</button>))
  expect(screen.queryByText('Export current chat')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export next conversation' })).toBeInTheDocument()
  act(() => oldChat.onShareButtonRender(null))
  expect(screen.queryByTestId('knowledge-chat-actions')).not.toBeInTheDocument()
  rerender(
    <KnowledgeDetailPanel selectedKb={{ ...knowledgeBase, id: 99 }} currentView="notebook" />
  )
  expect(screen.queryByRole('button', { name: 'Export current chat' })).not.toBeInTheDocument()
  act(() => oldChat.onShareButtonRender(<button>Obsolete export</button>))
  expect(screen.queryByText('Obsolete export')).not.toBeInTheDocument()
})

it('keeps the document list mounted while permissions are open', () => {
  const classic = { ...knowledgeBase, kb_type: 'classic' as const }
  render(
    <KnowledgeDetailPanel selectedKb={classic} currentView="documents" verifiedRole="Maintainer" />
  )
  const list = screen.getByTestId('mock-classic-document-list')
  fireEvent.mouseDown(screen.getByTestId('knowledge-detail-permissions-tab'), { button: 0 })
  fireEvent.click(screen.getByTestId('knowledge-detail-permissions-tab'))
  expect(screen.getByTestId('mock-classic-document-list')).toBe(list)
})
