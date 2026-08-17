// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
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
    myPermission: { role: 'Editor' },
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
  DocumentList: () => null,
}))

jest.mock('@/features/knowledge/permission/components/PermissionManagementTab', () => ({
  PermissionManagementTab: () => null,
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
