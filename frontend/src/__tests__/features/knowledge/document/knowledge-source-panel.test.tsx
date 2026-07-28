// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { KnowledgeSourcePanel } from '@/features/knowledge/document/components/KnowledgeSourcePanel'
import type { KnowledgeBase } from '@/types/knowledge'

const mockDocumentList = jest.fn()
const mockWorkspaceSidePanel = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/document/components/WorkspaceSidePanel', () => ({
  WorkspaceSidePanel: (props: {
    children: React.ReactNode
    defaultWidth: number
    minWidth: number
    maxWidth: number
  }) => {
    mockWorkspaceSidePanel(props)
    return <div>{props.children}</div>
  },
}))

jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: (props: {
    onSelectionChange?: (ids: number[]) => void
    onDocumentsChanged?: () => void
  }) => {
    mockDocumentList(props)
    return (
      <>
        <button
          data-testid="mock-select-document"
          onClick={() => props.onSelectionChange?.([11])}
        />
        <button data-testid="mock-sources-changed" onClick={() => props.onDocumentsChanged?.()} />
      </>
    )
  },
}))

const knowledgeBase: KnowledgeBase = {
  id: 12,
  name: 'organization-kb',
  description: null,
  user_id: 7,
  namespace: 'organization-name',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 0,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
}

const defaultProps = {
  knowledgeBase,
  selectedDocumentIds: [] as number[],
  availableDocumentCount: null,
  processingDocumentCount: 0,
  canUploadDocuments: false,
  canManageAllDocuments: false,
  mobileVisible: true,
  refreshToken: 0,
  onDocumentSelectionChange: jest.fn(),
  onSourcesChanged: jest.fn(),
}

describe('KnowledgeSourcePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the main document browser dimensions and compact layout', () => {
    render(<KnowledgeSourcePanel {...defaultProps} />)

    expect(screen.queryByText('artifact.materials')).not.toBeInTheDocument()
    expect(mockWorkspaceSidePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultWidth: 420,
        minWidth: 280,
        maxWidth: 600,
      })
    )
    expect(mockDocumentList).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBase,
        compact: true,
        paginationEnabled: true,
        sourceWorkspace: true,
        selectedDocumentIds: [],
        availableDocumentCount: null,
      })
    )
  })

  it('forwards knowledge context, permissions, refresh state, and routing', () => {
    const groupInfo = {
      groupId: 'group-1',
      groupName: 'Organization',
      groupType: 'organization' as const,
    }
    const onGroupClick = jest.fn()
    const onRefreshKnowledgeBase = jest.fn()

    render(
      <KnowledgeSourcePanel
        {...defaultProps}
        canUploadDocuments
        canManageAllDocuments
        selectedDocumentIds={[7]}
        availableDocumentCount={36}
        processingDocumentCount={2}
        refreshToken={3}
        groupInfo={groupInfo}
        onGroupClick={onGroupClick}
        onRefreshKnowledgeBase={onRefreshKnowledgeBase}
        initialDocPath="guide.md"
        initialDocumentId={31}
        isOrganization
      />
    )

    expect(mockDocumentList).toHaveBeenLastCalledWith(
      expect.objectContaining({
        canUpload: true,
        canManageAllDocuments: true,
        selectedDocumentIds: [7],
        availableDocumentCount: 36,
        processingDocumentCount: 2,
        refreshToken: 3,
        groupInfo,
        onGroupClick,
        onRefreshKnowledgeBase,
        initialDocPath: 'guide.md',
        initialDocumentId: 31,
        isOrganization: true,
      })
    )
  })

  it('shares selection and document changes with the workspace', () => {
    const onDocumentSelectionChange = jest.fn()
    const onSourcesChanged = jest.fn()
    render(
      <KnowledgeSourcePanel
        {...defaultProps}
        onDocumentSelectionChange={onDocumentSelectionChange}
        onSourcesChanged={onSourcesChanged}
      />
    )

    fireEvent.click(screen.getByTestId('mock-select-document'))
    fireEvent.click(screen.getByTestId('mock-sources-changed'))

    expect(onDocumentSelectionChange).toHaveBeenCalledWith([11])
    expect(onSourcesChanged).toHaveBeenCalledTimes(1)
  })
})
