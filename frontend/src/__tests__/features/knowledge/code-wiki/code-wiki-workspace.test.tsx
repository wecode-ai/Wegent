// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { CodeWikiWorkspace } from '@/features/knowledge/code-wiki/CodeWikiWorkspace'
import type { KnowledgeBase } from '@/types/knowledge'

const mockCanManageKnowledgeBase = jest.fn()
const mockCanManageKnowledgeBaseDocuments = jest.fn()
const mockCanManageKnowledgeBasePermissions = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 7 } }),
}))

jest.mock('@/features/knowledge/document/hooks/useNamespaceRoleMap', () => ({
  useNamespaceRoleMap: () => new Map(),
}))

jest.mock('@/features/knowledge/permission/hooks/useKnowledgePermissions', () => ({
  useKnowledgePermissions: () => ({
    myPermission: { role: 'owner' },
    fetchMyPermission: jest.fn(),
  }),
}))

jest.mock('@/utils/namespace-permissions', () => ({
  canManageKnowledgeBase: (...args: unknown[]) => mockCanManageKnowledgeBase(...args),
  canManageKnowledgeBaseDocuments: (...args: unknown[]) =>
    mockCanManageKnowledgeBaseDocuments(...args),
  canManageKnowledgeBasePermissions: (...args: unknown[]) =>
    mockCanManageKnowledgeBasePermissions(...args),
}))

jest.mock('@/features/knowledge/code-wiki/CodeWikiReader', () => ({
  CodeWikiReader: ({ canConfigure }: { canConfigure: boolean }) => (
    <div data-testid="mock-code-wiki-reader" data-can-configure={String(canConfigure)} />
  ),
}))

jest.mock('@/features/knowledge/document/components/DocumentList', () => ({
  DocumentList: ({
    contentOrigin,
    readOnly,
    canUpload,
    headerActions,
    groupInfo,
  }: {
    contentOrigin?: string
    readOnly?: boolean
    canUpload?: boolean
    headerActions?: ReactNode
    groupInfo?: { groupId: string }
  }) => (
    <>
      <div
        data-testid="mock-code-wiki-document-list"
        data-origin={contentOrigin}
        data-read-only={String(readOnly)}
        data-can-upload={String(canUpload)}
        data-group-id={groupInfo?.groupId}
      />
      {headerActions}
    </>
  ),
}))

jest.mock('@/features/knowledge/permission/components/PermissionManagementTab', () => ({
  PermissionManagementTab: () => <div data-testid="mock-code-wiki-permissions" />,
}))

const wiki: KnowledgeBase = {
  id: 42,
  name: 'workspace-wiki',
  description: null,
  user_id: 7,
  namespace: 'default',
  document_count: 0,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 5,
  exempt_calls_before_check: 0,
  kb_type: 'code_wiki',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
}

describe('CodeWikiWorkspace', () => {
  beforeEach(() => {
    mockCanManageKnowledgeBase.mockReturnValue(true)
    mockCanManageKnowledgeBaseDocuments.mockReturnValue(true)
    mockCanManageKnowledgeBasePermissions.mockReturnValue(true)
  })

  it('renders the supplied top-level view and presents virtual roots in the document header', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CodeWikiWorkspace wiki={wiki} view="wiki" />)

    expect(screen.getByTestId('mock-code-wiki-reader')).toBeInTheDocument()
    expect(screen.getByTestId('mock-code-wiki-reader')).toHaveAttribute(
      'data-can-configure',
      'true'
    )

    rerender(
      <CodeWikiWorkspace
        wiki={wiki}
        view="documents"
        groupInfo={{ groupId: 'default', groupName: 'personal', groupType: 'personal' }}
      />
    )

    expect(screen.getByTestId('code-wiki-content-roots')).toBeInTheDocument()
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-origin',
      'generated'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-read-only',
      'true'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-can-upload',
      'false'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-group-id',
      'default'
    )

    await user.click(screen.getByTestId('code-wiki-content-user'))

    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-origin',
      'user'
    )
    expect(screen.getByTestId('mock-code-wiki-document-list')).toHaveAttribute(
      'data-read-only',
      'false'
    )

    await user.click(screen.getByTestId('code-wiki-content-permissions'))

    expect(screen.getByTestId('mock-code-wiki-permissions')).toBeInTheDocument()
  })

  it('does not expose permission management or configuration without manage permission', () => {
    mockCanManageKnowledgeBase.mockReturnValue(false)
    mockCanManageKnowledgeBaseDocuments.mockReturnValue(false)
    mockCanManageKnowledgeBasePermissions.mockReturnValue(false)

    const { rerender } = render(<CodeWikiWorkspace wiki={wiki} view="documents" />)

    expect(screen.queryByTestId('code-wiki-content-permissions')).not.toBeInTheDocument()

    rerender(<CodeWikiWorkspace wiki={wiki} view="wiki" />)
    expect(screen.getByTestId('mock-code-wiki-reader')).toHaveAttribute(
      'data-can-configure',
      'false'
    )
  })
})
