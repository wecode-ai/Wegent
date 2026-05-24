// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { DocumentList } from '@/features/knowledge/document/components/DocumentList'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    replace: jest.fn(),
  }),
  usePathname: () => '/',
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      id: 1,
    },
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: [],
    loading: false,
    error: null,
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    batchDelete: jest.fn(),
    refresh: jest.fn(),
    fetchWithFolder: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useFolders', () => ({
  useFolders: () => ({
    folders: [],
    loading: false,
    createFolder: jest.fn(),
    updateFolder: jest.fn(),
    deleteFolder: jest.fn(),
    fetchFolders: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useColumnResize', () => ({
  useColumnResize: () => ({
    widthOverride: undefined,
    isResizing: false,
    handleMouseDown: jest.fn(),
    columnRef: { current: null },
  }),
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/DocumentUpload', () => ({
  DocumentUpload: () => null,
}))
jest.mock('@/features/knowledge/document/components/DeleteDocumentDialog', () => ({
  DeleteDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/EditDocumentDialog', () => ({
  EditDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/RetrievalTestDialog', () => ({
  RetrievalTestDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/FolderTree', () => ({
  FolderTree: () => null,
}))
jest.mock('@/features/knowledge/document/components/CreateFolderDialog', () => ({
  CreateFolderDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/DeleteFolderDialog', () => ({
  DeleteFolderDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/MoveDocumentDialog', () => ({
  MoveDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/EditKnowledgeBaseSummaryDialog', () => ({
  EditKnowledgeBaseSummaryDialog: () => null,
}))

function createKnowledgeBase(overrides?: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: 1,
    name: 'Test KB',
    description: null,
    user_id: 1,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: true,
    summary: {
      status: 'failed',
      long_summary: 'AI summary',
      manual_long_summary: 'Manual summary',
      has_manual_override: true,
      error: 'AI failed',
    },
    kb_type: 'classic',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

describe('DocumentList summary header', () => {
  it('shows inline summary edit button when manual summary exists after AI failure', () => {
    render(<DocumentList knowledgeBase={createKnowledgeBase()} canManageAllDocuments={true} />)

    expect(screen.getByTestId('kb-summary-inline-edit-button')).toBeInTheDocument()
  })

  it('shows inline summary edit button when no summary exists yet', () => {
    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({
          summary: {
            status: 'pending',
          },
        })}
        canManageAllDocuments={true}
      />
    )

    expect(screen.getByTestId('kb-summary-inline-edit-button')).toBeInTheDocument()
  })

  it('hides retry button when summary generation is disabled', () => {
    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({
          summary_enabled: false,
        })}
        canManageAllDocuments={true}
      />
    )

    expect(screen.queryByText('chatPage.summaryRetry')).not.toBeInTheDocument()
  })
})
